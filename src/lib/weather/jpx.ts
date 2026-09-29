/**
 * JPEG 2000 (ITU-T T.800) decoding, enough for GRIB2 template 5.40: a raw
 * codestream (or one wrapped in JP2 boxes), any number of tiles, one or more
 * components of up to 16 bits, reversible 5/3 or irreversible 9/7 wavelets,
 * layers, precincts, all five progression orders, and the code-block styles
 * except selective arithmetic bypass. Returns the first component's samples,
 * row by row, which in GRIB are the packed integers.
 *
 * Written from the standard: the tier-2 packet headers (tag trees and
 * lengths), the MQ arithmetic decoder of Annex C, the EBCOT passes of Annex D
 * with their contexts, the dequantisation of Annex E and the inverse wavelet
 * of Annex F. Tested against codestreams OpenJPEG writes.
 */

// ------------------------------------------------------------ MQ decoder

// Annex C, Table C.2: Qe, next state on MPS, next state on LPS, and the switch.
const QE = [
  0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521, 0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601, 0x5601, 0x5401,
  0x5101, 0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801, 0x1601, 0x1401, 0x1201, 0x1101, 0x0ac1, 0x09c1,
  0x08a1, 0x0521, 0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049, 0x0025, 0x0015, 0x0009, 0x0005, 0x0001, 0x5601,
]
const NMPS = [
  1, 2, 3, 4, 5, 38, 7, 8, 9, 10, 11, 12, 13, 29, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 45, 46,
]
const NLPS = [
  1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46,
]
const SWITCH = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

class MQ {
  private a = 0
  private chigh = 0
  private clow = 0
  private ct = 0
  private bp: number
  constructor(private readonly d: Uint8Array, start: number, private readonly end: number) {
    this.bp = start
    this.chigh = start < end ? d[start] : 0xff
    this.clow = 0
    this.byteIn()
    this.chigh = ((this.chigh << 7) & 0xffff) | ((this.clow >> 9) & 0x7f)
    this.clow = (this.clow << 7) & 0xffff
    this.ct -= 7
    this.a = 0x8000
  }
  private byteIn() {
    const d = this.d
    const cur = this.bp < this.end ? d[this.bp] : 0xff
    if (cur === 0xff) {
      const next = this.bp + 1 < this.end ? d[this.bp + 1] : 0xff
      if (next > 0x8f) {
        this.clow += 0xff00
        this.ct = 8
      } else {
        this.bp++
        this.clow += next << 9
        this.ct = 7
      }
    } else {
      this.bp++
      this.clow += (this.bp < this.end ? d[this.bp] : 0xff) << 8
      this.ct = 8
    }
    if (this.clow > 0xffff) {
      this.chigh += this.clow >> 16
      this.clow &= 0xffff
    }
  }
  /** One decision in context `cx`; `st` holds each context as state << 1 | mps. */
  bit(st: Uint8Array, cx: number): number {
    let s = st[cx] >> 1
    let mps = st[cx] & 1
    const qe = QE[s]
    let a = this.a - qe
    let d: number
    if (this.chigh < qe) {
      // The LPS exchange: the lower interval.
      if (a < qe) {
        a = qe
        d = mps
        s = NMPS[s]
      } else {
        a = qe
        d = 1 ^ mps
        if (SWITCH[s]) mps = d
        s = NLPS[s]
      }
    } else {
      this.chigh -= qe
      if (a & 0x8000) {
        this.a = a
        return mps
      }
      if (a < qe) {
        d = 1 ^ mps
        if (SWITCH[s]) mps = d
        s = NLPS[s]
      } else {
        d = mps
        s = NMPS[s]
      }
    }
    do {
      if (this.ct === 0) this.byteIn()
      a <<= 1
      this.chigh = ((this.chigh << 1) & 0xffff) | ((this.clow >> 15) & 1)
      this.clow = (this.clow << 1) & 0xffff
      this.ct--
    } while (!(a & 0x8000))
    this.a = a
    st[cx] = (s << 1) | mps
    return d
  }
}

// ---------------------------------------------------------- EBCOT (tier 1)

const CX_RL = 17
const CX_UNI = 18

function freshContexts(): Uint8Array {
  const st = new Uint8Array(19)
  st[0] = 4 << 1
  st[CX_RL] = 3 << 1
  st[CX_UNI] = 46 << 1
  return st
}

/** Zero-coding context by band orientation (0 LL/LH, 1 HL, 2 HH) from neighbour counts. */
function zcContext(orient: number, h: number, v: number, d: number): number {
  if (orient === 1) [h, v] = [v, h]
  if (orient !== 2) {
    if (h === 2) return 8
    if (h === 1) return v >= 1 ? 7 : d >= 1 ? 6 : 5
    if (v === 2) return 4
    if (v === 1) return 3
    return d >= 2 ? 2 : d === 1 ? 1 : 0
  }
  const hv = h + v
  if (d >= 3) return 8
  if (d === 2) return hv >= 1 ? 7 : 6
  if (d === 1) return hv >= 2 ? 5 : hv === 1 ? 4 : 3
  return hv >= 2 ? 2 : hv === 1 ? 1 : 0
}

interface CodeBlock {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Data per segment, and how many passes each holds. */
  chunks: Uint8Array[]
  segPasses: number[]
  segLens: number[]
  passes: number
  zeroPlanes: number
  lblock: number
  included: boolean
}

/**
 * Decode one code-block's passes into signed integer magnitudes, at bit-plane
 * resolution (the least significant decoded plane is bit 0 of `mb` planes).
 * Returns the values and the lowest bit-plane reached, for reconstruction.
 */
function decodeBlock(cb: CodeBlock, orient: number, mb: number, style: number): { v: Int32Array; low: number } {
  const w = cb.x1 - cb.x0
  const h = cb.y1 - cb.y0
  const n = w * h
  const mag = new Int32Array(n)
  const sign = new Uint8Array(n)
  const sig = new Uint8Array(n)
  const visited = new Uint8Array(n)
  const refined = new Uint8Array(n)
  /** The lowest bit-plane each coefficient's magnitude is known to, for its midpoint. */
  const known = new Uint8Array(n)
  if (!cb.passes || w <= 0 || h <= 0) return { v: mag, low: 0 }
  const vcausal = (style & 0x08) !== 0
  const reset = (style & 0x02) !== 0
  const segsym = (style & 0x20) !== 0
  if (style & 0x01) throw new Error('JPEG 2000 selective arithmetic bypass is not read')

  // Segments: one per pass with termination on each pass, else all in one.
  const total = cb.chunks.reduce((s, c) => s + c.length, 0)
  const data = new Uint8Array(total + 2)
  let off = 0
  for (const c of cb.chunks) {
    data.set(c, off)
    off += c.length
  }
  data[total] = 0xff
  data[total + 1] = 0xff
  const segStarts: number[] = []
  const segEnds: number[] = []
  {
    let at = 0
    for (const len of cb.segLens) {
      segStarts.push(at)
      at += len
      segEnds.push(at)
    }
  }

  const st = freshContexts()
  let seg = 0
  let passInSeg = 0
  let mq = new MQ(data, segStarts[0] ?? 0, segEnds[0] ?? total)
  const nextPass = () => {
    passInSeg++
    if (passInSeg >= (cb.segPasses[seg] ?? Infinity) && seg + 1 < cb.segLens.length) {
      seg++
      passInSeg = 0
      mq = new MQ(data, segStarts[seg], segEnds[seg])
    }
    if (reset) st.set(freshContexts())
  }

  const isSig = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? sig[y * w + x] : 0)
  const sgn = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h && sig[y * w + x] ? (sign[y * w + x] ? -1 : 1) : 0)
  /** Neighbours of (x, y), with the next stripe's row ignored under vertical causality. */
  const counts = (x: number, y: number) => {
    const below = vcausal && (y & 3) === 3 ? 0 : 1
    const hh = isSig(x - 1, y) + isSig(x + 1, y)
    const vv = isSig(x, y - 1) + (below ? isSig(x, y + 1) : 0)
    const dd = isSig(x - 1, y - 1) + isSig(x + 1, y - 1) + (below ? isSig(x - 1, y + 1) + isSig(x + 1, y + 1) : 0)
    return [hh, vv, dd]
  }
  const decodeSign = (x: number, y: number) => {
    const below = vcausal && (y & 3) === 3 ? 0 : 1
    const hc = Math.max(-1, Math.min(1, sgn(x - 1, y) + sgn(x + 1, y)))
    const vc = Math.max(-1, Math.min(1, sgn(x, y - 1) + (below ? sgn(x, y + 1) : 0)))
    let cx: number
    let xor = 0
    if (hc === 1) cx = vc === 1 ? 13 : vc === 0 ? 12 : 11
    else if (hc === 0) {
      cx = vc === 0 ? 9 : 10
      if (vc === -1) xor = 1
    } else {
      cx = vc === -1 ? 13 : vc === 0 ? 12 : 11
      xor = 1
    }
    return mq.bit(st, cx) ^ xor
  }

  let plane = mb - 1 - cb.zeroPlanes
  let kind = 2 // the first pass is a cleanup pass
  let low = plane
  for (let p = 0; p < cb.passes && plane >= 0; p++) {
    const one = 1 << plane
    if (kind === 0) {
      // Significance propagation.
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = y0; y < Math.min(y0 + 4, h); y++) {
            const i = y * w + x
            if (sig[i]) continue
            const [hh, vv, dd] = counts(x, y)
            if (hh + vv + dd === 0) continue
            visited[i] = 1
            if (mq.bit(st, zcContext(orient, hh, vv, dd))) {
              sign[i] = decodeSign(x, y)
              mag[i] |= one
              sig[i] = 1
              known[i] = plane
            }
          }
        }
      }
    } else if (kind === 1) {
      // Magnitude refinement.
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = y0; y < Math.min(y0 + 4, h); y++) {
            const i = y * w + x
            if (!sig[i] || visited[i]) continue
            let cx: number
            if (refined[i]) cx = 16
            else {
              const [hh, vv, dd] = counts(x, y)
              cx = hh + vv + dd > 0 ? 15 : 14
            }
            if (mq.bit(st, cx)) mag[i] |= one
            refined[i] = 1
            known[i] = plane
          }
        }
      }
    } else {
      // Cleanup, with run-length coding down clean columns of a full stripe.
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          let y = y0
          const yEnd = Math.min(y0 + 4, h)
          if (yEnd - y0 === 4) {
            let clean = true
            for (let yy = y0; yy < yEnd && clean; yy++) {
              const i = yy * w + x
              if (sig[i] || visited[i]) clean = false
              else {
                const [hh, vv, dd] = counts(x, yy)
                if (hh + vv + dd) clean = false
              }
            }
            if (clean) {
              if (!mq.bit(st, CX_RL)) continue
              const r = (mq.bit(st, CX_UNI) << 1) | mq.bit(st, CX_UNI)
              y = y0 + r
              const i = y * w + x
              sign[i] = decodeSign(x, y)
              mag[i] |= one
              sig[i] = 1
              known[i] = plane
              y++
            }
          }
          for (; y < yEnd; y++) {
            const i = y * w + x
            if (sig[i] || visited[i]) continue
            const [hh, vv, dd] = counts(x, y)
            if (mq.bit(st, zcContext(orient, hh, vv, dd))) {
              sign[i] = decodeSign(x, y)
              mag[i] |= one
              sig[i] = 1
              known[i] = plane
            }
          }
        }
      }
      if (segsym) for (let k = 0; k < 4; k++) mq.bit(st, CX_UNI)
      visited.fill(0)
    }
    low = plane
    if (kind === 2) {
      kind = 0
      plane--
    } else kind++
    nextPass()
  }
  // Each coefficient in the middle of what is still unknown about it: nothing
  // for one decoded to bit 0, half its last known bit-plane otherwise.
  const v = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const m = sig[i] && known[i] > 0 ? mag[i] + (1 << (known[i] - 1)) : mag[i]
    v[i] = sign[i] ? -m : m
  }
  return { v, low }
}

// ---------------------------------------------------------- tier 2 (packets)

/** Bits of a packet header, with the bit after an 0xFF byte stuffed. */
class HeaderBits {
  private byte = 0
  private left = 0
  private prevFF = false
  constructor(private readonly d: Uint8Array, public pos: number) {}
  bit(): number {
    if (this.left === 0) {
      this.byte = this.d[this.pos++] ?? 0
      this.left = this.prevFF ? 7 : 8
      this.prevFF = this.byte === 0xff
    }
    this.left--
    return (this.byte >> this.left) & 1
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v
  }
  /** To the next byte, skipping the stuffing after an 0xFF. */
  align() {
    this.left = 0
    if (this.prevFF) {
      this.pos++
      this.prevFF = false
    }
  }
}

class TagTree {
  private readonly levels: Array<{ w: number; h: number; value: Int32Array; known: Uint8Array }> = []
  constructor(w: number, h: number) {
    for (;;) {
      this.levels.push({ w, h, value: new Int32Array(w * h), known: new Uint8Array(w * h) })
      if (w === 1 && h === 1) break
      w = Math.ceil(w / 2)
      h = Math.ceil(h / 2)
    }
  }
  private lower = new Map<string, number>()
  /**
   * Decode down the tree to leaf (x, y) far enough to tell whether its value is
   * below `threshold`; returns the value if known and below, else Infinity.
   */
  decode(hb: HeaderBits, x: number, y: number, threshold: number): number {
    let lo = 0
    for (let k = this.levels.length - 1; k >= 0; k--) {
      const l = this.levels[k]
      const i = (y >> k) * l.w + (x >> k)
      const key = `${k},${i}`
      let v = Math.max(this.lower.get(key) ?? 0, lo)
      while (!l.known[i] && v < threshold) {
        if (hb.bit()) {
          l.known[i] = 1
          l.value[i] = v
        } else v++
      }
      this.lower.set(key, v)
      if (!l.known[i]) return Infinity
      lo = l.value[i]
    }
    return lo
  }
}

// ------------------------------------------------------------ the wavelet

const ALPHA = -1.586134342059924
const BETA = -0.052980118572961
const GAMMA = 0.882911075530934
const DELTA = 0.443506852043971
const KAPPA = 1.230174104914001

/** Inverse 1-D transform of `x[0..n)` whose first sample sits at absolute index `i0`. */
function inverse1d(x: Float64Array, n: number, i0: number, reversible: boolean, tmp: Float64Array) {
  if (n === 1) {
    if (i0 & 1) x[0] = reversible ? Math.trunc(x[0] / 2) : x[0] / 2
    return
  }
  const P = 4
  for (let i = 0; i < n; i++) tmp[P + i] = x[i]
  // Whole-sample symmetric extension.
  for (let k = 1; k <= P; k++) {
    tmp[P - k] = tmp[P + reflect(-k, n)]
    tmp[P + n - 1 + k] = tmp[P + reflect(n - 1 + k, n)]
  }
  const even = (j: number) => ((i0 + j) & 1) === 0
  const lo = -P
  const hi = n + P
  if (reversible) {
    for (let j = lo + 1; j < hi - 1; j++) if (even(j)) tmp[P + j] -= Math.floor((tmp[P + j - 1] + tmp[P + j + 1] + 2) / 4)
    for (let j = lo + 1; j < hi - 1; j++) if (!even(j)) tmp[P + j] += Math.floor((tmp[P + j - 1] + tmp[P + j + 1]) / 2)
  } else {
    for (let j = lo; j < hi; j++) tmp[P + j] *= even(j) ? KAPPA : 1 / KAPPA
    for (let j = lo + 1; j < hi - 1; j++) if (even(j)) tmp[P + j] -= DELTA * (tmp[P + j - 1] + tmp[P + j + 1])
    for (let j = lo + 1; j < hi - 1; j++) if (!even(j)) tmp[P + j] -= GAMMA * (tmp[P + j - 1] + tmp[P + j + 1])
    for (let j = lo + 1; j < hi - 1; j++) if (even(j)) tmp[P + j] -= BETA * (tmp[P + j - 1] + tmp[P + j + 1])
    for (let j = lo + 1; j < hi - 1; j++) if (!even(j)) tmp[P + j] -= ALPHA * (tmp[P + j - 1] + tmp[P + j + 1])
  }
  for (let i = 0; i < n; i++) x[i] = tmp[P + i]
}

function reflect(i: number, n: number): number {
  const period = 2 * (n - 1)
  let k = ((i % period) + period) % period
  if (k >= n) k = period - k
  return k
}

// ------------------------------------------------------------- the stream

interface Coding {
  levels: number
  xcb: number
  ycb: number
  style: number
  reversible: boolean
  precincts: Array<[number, number]>
}
interface Quant {
  guard: number
  style: number
  steps: Array<[number, number]>
}
interface Comp {
  prec: number
  signed: boolean
  dx: number
  dy: number
}

export interface JpxImage {
  width: number
  height: number
  /** The first component, row by row, as integers. */
  samples: Int32Array
  precision: number
  components: number
}

const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1]
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]

/** The codestream inside a JP2 file, or the bytes themselves if they are one. */
function codestream(d: Uint8Array): Uint8Array {
  if (d[0] === 0xff && d[1] === 0x4f) return d
  let at = 0
  while (at + 8 <= d.length) {
    let len = u32(d, at)
    const type = String.fromCharCode(d[at + 4], d[at + 5], d[at + 6], d[at + 7])
    let head = 8
    if (len === 1) {
      len = u32(d, at + 12)
      head = 16
    } else if (len === 0) len = d.length - at
    if (type === 'jp2c') return d.subarray(at + head, at + len)
    at += len
  }
  throw new Error('not a JPEG 2000 codestream')
}

export function decodeJpx(input: Uint8Array): JpxImage {
  const d = codestream(input)
  let at = 2
  let X = 0
  let Y = 0
  let XO = 0
  let YO = 0
  let XT = 0
  let YT = 0
  let XTO = 0
  let YTO = 0
  const comps: Comp[] = []
  let cod: Coding | null = null
  let order = 0
  let layers = 1
  let sop = false
  let eph = false
  let qcd: Quant | null = null
  const coc = new Map<number, Coding>()
  const qcc = new Map<number, Quant>()
  const tileParts = new Map<number, Uint8Array[]>()

  const readCoding = (o: number, len: number, scod: number): Coding => {
    const levels = d[o]
    const xcb = (d[o + 1] & 0x0f) + 2
    const ycb = (d[o + 2] & 0x0f) + 2
    const style = d[o + 3]
    const reversible = d[o + 4] === 1
    const precincts: Array<[number, number]> = []
    for (let r = 0; r <= levels; r++) precincts.push(scod & 1 && o + 5 + r < o + len ? [d[o + 5 + r] & 0x0f, d[o + 5 + r] >> 4] : [15, 15])
    return { levels, xcb, ycb, style, reversible, precincts }
  }
  const readQuant = (o: number, len: number): Quant => {
    const s = d[o]
    const style = s & 0x1f
    const steps: Array<[number, number]> = []
    if (style === 0) for (let i = 1; i < len; i++) steps.push([d[o + i] >> 3, 0])
    else for (let i = 1; i + 1 < len; i += 2) steps.push([d[o + i] >> 3, ((d[o + i] & 7) << 8) | d[o + i + 1]])
    return { guard: s >> 5, style, steps }
  }

  // Main header, then the tile-parts.
  if (u16(d, 0) !== 0xff4f) throw new Error('not a JPEG 2000 codestream')
  while (at + 4 <= d.length) {
    const m = u16(d, at)
    if (m === 0xffd9) break
    const len = u16(d, at + 2)
    const o = at + 4
    if (m === 0xff51) {
      X = u32(d, o + 2)
      Y = u32(d, o + 6)
      XO = u32(d, o + 10)
      YO = u32(d, o + 14)
      XT = u32(d, o + 18)
      YT = u32(d, o + 22)
      XTO = u32(d, o + 26)
      YTO = u32(d, o + 30)
      const nc = u16(d, o + 34)
      for (let c = 0; c < nc; c++) {
        const s = d[o + 36 + 3 * c]
        comps.push({ prec: (s & 0x7f) + 1, signed: (s & 0x80) !== 0, dx: d[o + 37 + 3 * c], dy: d[o + 38 + 3 * c] })
      }
    } else if (m === 0xff52) {
      const scod = d[o]
      sop = (scod & 2) !== 0
      eph = (scod & 4) !== 0
      order = d[o + 1]
      layers = u16(d, o + 2)
      cod = readCoding(o + 5, len - 7, scod)
    } else if (m === 0xff53) {
      const wide = comps.length >= 257
      const c = wide ? u16(d, o) : d[o]
      const k = wide ? 2 : 1
      coc.set(c, readCoding(o + k + 1, len - 2 - k - 1, d[o + k]))
    } else if (m === 0xff5c) {
      qcd = readQuant(o, len - 2)
    } else if (m === 0xff5d) {
      const wide = comps.length >= 257
      const c = wide ? u16(d, o) : d[o]
      qcc.set(c, readQuant(o + (wide ? 2 : 1), len - 2 - (wide ? 2 : 1)))
    } else if (m === 0xff5f) {
      throw new Error('a JPEG 2000 progression order change is not read')
    } else if (m === 0xff60 || m === 0xff61) {
      throw new Error('JPEG 2000 packed packet headers are not read')
    } else if (m === 0xff90) {
      const isot = u16(d, o)
      const psot = u32(d, o + 2)
      const end = psot ? at + psot : d.length - 2
      // Find SOD, skipping any tile-part header markers (read as main-header values).
      let p = at + 2 + len
      while (p + 2 <= end && u16(d, p) !== 0xff93) {
        const mm = u16(d, p)
        const ll = u16(d, p + 2)
        if (mm === 0xff52 || mm === 0xff53 || mm === 0xff5c || mm === 0xff5d) {
          throw new Error('JPEG 2000 tile-part coding or quantisation markers are not read')
        }
        p += 2 + ll
      }
      const list = tileParts.get(isot) ?? []
      list.push(d.subarray(p + 2, end))
      tileParts.set(isot, list)
      at = end
      continue
    }
    at += 2 + len
  }
  if (!cod || !qcd || !comps.length) throw new Error('the JPEG 2000 header is incomplete')

  const width = X - XO
  const height = Y - YO
  const comp = comps[0]
  const coding = coc.get(0) ?? cod
  const quant = qcc.get(0) ?? qcd
  const out = new Int32Array(Math.max(0, width * height))
  const nxT = Math.ceil((X - XTO) / XT)
  const nyT = Math.ceil((Y - YTO) / YT)

  for (let t = 0; t < nxT * nyT; t++) {
    const p = t % nxT
    const q = Math.floor(t / nxT)
    const tx0 = Math.max(XTO + p * XT, XO)
    const tx1 = Math.min(XTO + (p + 1) * XT, X)
    const ty0 = Math.max(YTO + q * YT, YO)
    const ty1 = Math.min(YTO + (q + 1) * YT, Y)
    const data = concat(tileParts.get(t) ?? [])
    const tile = decodeTile(data, { tx0, tx1, ty0, ty1 }, comps, coding, coc, quant, qcc, order, layers, sop, eph, cod)
    const c0x = Math.ceil(tx0 / comp.dx)
    const c0y = Math.ceil(ty0 / comp.dy)
    const cw = Math.ceil(tx1 / comp.dx) - c0x
    const ch = Math.ceil(ty1 / comp.dy) - c0y
    const ox = c0x - Math.ceil(XO / comp.dx)
    const oy = c0y - Math.ceil(YO / comp.dy)
    const imgW = Math.ceil(X / comp.dx) - Math.ceil(XO / comp.dx)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[(oy + y) * imgW + ox + x] = tile[y * cw + x]
  }
  return { width: Math.ceil(X / comp.dx) - Math.ceil(XO / comp.dx), height: Math.ceil(Y / comp.dy) - Math.ceil(YO / comp.dy), samples: out, precision: comp.prec, components: comps.length }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n)
  let k = 0
  for (const p of parts) {
    out.set(p, k)
    k += p.length
  }
  return out
}

interface Band {
  orient: number // 0 LL, 1 HL, 2 LH, 3 HH (LH is coded like LL)
  x0: number
  y0: number
  x1: number
  y1: number
  mb: number
  step: number
  blocks: CodeBlock[]
  /** Code-blocks of each precinct, raster order, and that precinct's block grid. */
  byPrecinct: Array<{ blocks: CodeBlock[]; w: number; h: number; incl: TagTree; zero: TagTree }>
}
interface Resolution {
  x0: number
  y0: number
  x1: number
  y1: number
  bands: Band[]
  npx: number
  npy: number
}

/** Decode one tile's samples for component 0 (the others' packets are read past). */
function decodeTile(
  data: Uint8Array,
  t: { tx0: number; tx1: number; ty0: number; ty1: number },
  comps: Comp[],
  cod0: Coding,
  coc: Map<number, Coding>,
  qcd0: Quant,
  qcc: Map<number, Quant>,
  order: number,
  layers: number,
  sop: boolean,
  eph: boolean,
  cod: Coding,
): Int32Array {
  // Every component's structure: packets interleave them, so all must be known.
  const all = comps.map((c, ci) => {
    const coding = ci === 0 ? cod0 : (coc.get(ci) ?? cod)
    const quant = ci === 0 ? qcd0 : (qcc.get(ci) ?? qcd0)
    return buildComponent(c, coding, quant, t)
  })
  const hb = new HeaderBits(data, 0)
  const maxR = Math.max(...all.map((a) => a.res.length))
  const packet = (ci: number, r: number, k: number, l: number) => {
    const cc = all[ci]
    if (r >= cc.res.length) return
    const res = cc.res[r]
    if (k >= res.npx * res.npy) return
    readPacket(data, hb, res, k, l, sop, eph, (cc.coding.style & 0x04) !== 0)
  }
  // The five progression orders (Annex B.12), precincts in raster order.
  const npc = (ci: number, r: number) => (r < all[ci].res.length ? all[ci].res[r].npx * all[ci].res[r].npy : 0)
  const maxK = Math.max(...all.flatMap((a, ci) => a.res.map((_, r) => npc(ci, r))))
  if (order === 0) {
    for (let l = 0; l < layers; l++) for (let r = 0; r < maxR; r++) for (let ci = 0; ci < comps.length; ci++) for (let k = 0; k < npc(ci, r); k++) packet(ci, r, k, l)
  } else if (order === 1) {
    for (let r = 0; r < maxR; r++) for (let l = 0; l < layers; l++) for (let ci = 0; ci < comps.length; ci++) for (let k = 0; k < npc(ci, r); k++) packet(ci, r, k, l)
  } else {
    // Position-driven orders: each precinct placed at its top-left on the reference grid.
    type P = { ci: number; r: number; k: number; x: number; y: number }
    const ps: P[] = []
    for (let ci = 0; ci < comps.length; ci++) {
      const cc = all[ci]
      cc.res.forEach((res, r) => {
        const [ppx, ppy] = cc.coding.precincts[r]
        const scale = 2 ** (cc.coding.levels - r)
        for (let k = 0; k < res.npx * res.npy; k++) {
          const kx = k % res.npx
          const ky = Math.floor(k / res.npx)
          const px = Math.max(res.x0, (Math.floor(res.x0 / 2 ** ppx) + kx) * 2 ** ppx) * scale * comps[ci].dx
          const py = Math.max(res.y0, (Math.floor(res.y0 / 2 ** ppy) + ky) * 2 ** ppy) * scale * comps[ci].dy
          ps.push({ ci, r, k, x: px, y: py })
        }
      })
    }
    const cmp =
      order === 2
        ? (a: P, b: P) => a.r - b.r || a.y - b.y || a.x - b.x || a.ci - b.ci
        : order === 3
          ? (a: P, b: P) => a.y - b.y || a.x - b.x || a.ci - b.ci || a.r - b.r
          : (a: P, b: P) => a.ci - b.ci || a.y - b.y || a.x - b.x || a.r - b.r
    ps.sort(cmp)
    for (const pp of ps) for (let l = 0; l < layers; l++) packet(pp.ci, pp.r, pp.k, l)
    void maxK
  }
  return reconstruct(all[0], comps[0])
}

function buildComponent(c: Comp, coding: Coding, quant: Quant, t: { tx0: number; tx1: number; ty0: number; ty1: number }) {
  const tcx0 = Math.ceil(t.tx0 / c.dx)
  const tcx1 = Math.ceil(t.tx1 / c.dx)
  const tcy0 = Math.ceil(t.ty0 / c.dy)
  const tcy1 = Math.ceil(t.ty1 / c.dy)
  const NL = coding.levels
  const res: Resolution[] = []
  for (let r = 0; r <= NL; r++) {
    const s = 2 ** (NL - r)
    const rx0 = Math.ceil(tcx0 / s)
    const rx1 = Math.ceil(tcx1 / s)
    const ry0 = Math.ceil(tcy0 / s)
    const ry1 = Math.ceil(tcy1 / s)
    const [ppx, ppy] = coding.precincts[r]
    const npx = rx1 > rx0 ? Math.ceil(rx1 / 2 ** ppx) - Math.floor(rx0 / 2 ** ppx) : 0
    const npy = ry1 > ry0 ? Math.ceil(ry1 / 2 ** ppy) - Math.floor(ry0 / 2 ** ppy) : 0
    const bands: Band[] = []
    const orients = r === 0 ? [0] : [1, 2, 3]
    for (const orient of orients) {
      const nb = r === 0 ? NL : NL - r + 1
      const xob = orient === 1 || orient === 3 ? 1 : 0
      const yob = orient === 2 || orient === 3 ? 1 : 0
      const bx0 = Math.ceil((tcx0 - 2 ** (nb - 1) * xob) / 2 ** nb)
      const bx1 = Math.ceil((tcx1 - 2 ** (nb - 1) * xob) / 2 ** nb)
      const by0 = Math.ceil((tcy0 - 2 ** (nb - 1) * yob) / 2 ** nb)
      const by1 = Math.ceil((tcy1 - 2 ** (nb - 1) * yob) / 2 ** nb)
      // Step and magnitude bits (Annex E): the band's index in the QCD list.
      const bi = r === 0 ? 0 : 3 * (r - 1) + orient
      const [eps, mu] = quant.style === 1 ? [quant.steps[0][0] - NL + nb, quant.steps[0][1]] : (quant.steps[bi] ?? quant.steps[quant.steps.length - 1])
      const gain = orient === 0 ? 0 : orient === 3 ? 2 : 1
      const mb = quant.guard + eps - 1
      const step = coding.reversible ? 1 : 2 ** (c.prec + gain - eps) * (1 + mu / 2048)
      // Code-blocks: the precinct size in this band, capped by the code-block size.
      const pbx = r === 0 ? ppx : ppx - 1
      const pby = r === 0 ? ppy : ppy - 1
      const xcb = Math.min(coding.xcb, pbx)
      const ycb = Math.min(coding.ycb, pby)
      const band: Band = { orient, x0: bx0, y0: by0, x1: bx1, y1: by1, mb, step, blocks: [], byPrecinct: [] }
      for (let k = 0; k < npx * npy; k++) {
        // The precinct grid is anchored on the resolution; in a band it is half the size.
        const kx = Math.floor(rx0 / 2 ** ppx) + (k % npx)
        const ky = Math.floor(ry0 / 2 ** ppy) + Math.floor(k / npx)
        const px0 = Math.max(bx0, kx * 2 ** pbx)
        const px1 = Math.min(bx1, (kx + 1) * 2 ** pbx)
        const py0 = Math.max(by0, ky * 2 ** pby)
        const py1 = Math.min(by1, (ky + 1) * 2 ** pby)
        const blocks: CodeBlock[] = []
        let w = 0
        let h = 0
        if (px1 > px0 && py1 > py0) {
          const cx0 = Math.floor(px0 / 2 ** xcb)
          const cx1 = Math.ceil(px1 / 2 ** xcb)
          const cy0 = Math.floor(py0 / 2 ** ycb)
          const cy1 = Math.ceil(py1 / 2 ** ycb)
          w = cx1 - cx0
          h = cy1 - cy0
          for (let cy = cy0; cy < cy1; cy++) {
            for (let cx = cx0; cx < cx1; cx++) {
              const b: CodeBlock = {
                x0: Math.max(px0, cx * 2 ** xcb),
                x1: Math.min(px1, (cx + 1) * 2 ** xcb),
                y0: Math.max(py0, cy * 2 ** ycb),
                y1: Math.min(py1, (cy + 1) * 2 ** ycb),
                chunks: [],
                segPasses: [],
                segLens: [],
                passes: 0,
                zeroPlanes: 0,
                lblock: 3,
                included: false,
              }
              blocks.push(b)
              band.blocks.push(b)
            }
          }
        }
        band.byPrecinct.push({ blocks, w, h, incl: new TagTree(Math.max(1, w), Math.max(1, h)), zero: new TagTree(Math.max(1, w), Math.max(1, h)) })
      }
      bands.push(band)
    }
    res.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, bands, npx, npy })
  }
  return { res, coding, tc: { x0: tcx0, x1: tcx1, y0: tcy0, y1: tcy1 } }
}

function passCount(hb: HeaderBits): number {
  if (!hb.bit()) return 1
  if (!hb.bit()) return 2
  const two = hb.bits(2)
  if (two < 3) return 3 + two
  const five = hb.bits(5)
  if (five < 31) return 6 + five
  return 37 + hb.bits(7)
}

function readPacket(data: Uint8Array, hb: HeaderBits, res: Resolution, k: number, layer: number, sop: boolean, eph: boolean, termAll: boolean) {
  hb.align()
  if (sop && data[hb.pos] === 0xff && data[hb.pos + 1] === 0x91) hb.pos += 6
  const found: Array<{ b: CodeBlock; lens: number[]; passes: number[] }> = []
  if (hb.bit()) {
    for (const band of res.bands) {
      const pr = band.byPrecinct[k]
      if (!pr) continue
      for (let i = 0; i < pr.blocks.length; i++) {
        const b = pr.blocks[i]
        const x = i % pr.w
        const y = Math.floor(i / pr.w)
        let inc: boolean
        if (!b.included) inc = pr.incl.decode(hb, x, y, layer + 1) <= layer
        else inc = hb.bit() === 1
        if (!inc) continue
        if (!b.included) {
          b.zeroPlanes = pr.zero.decode(hb, x, y, Infinity)
          b.included = true
        }
        const np = passCount(hb)
        while (hb.bit()) b.lblock++
        // Lengths: one segment, or one per pass under termination on each pass.
        const lens: number[] = []
        const passes: number[] = []
        if (termAll) {
          for (let j = 0; j < np; j++) {
            lens.push(hb.bits(b.lblock))
            passes.push(1)
          }
        } else {
          lens.push(hb.bits(b.lblock + Math.floor(Math.log2(np))))
          passes.push(np)
        }
        found.push({ b, lens, passes })
      }
    }
  }
  hb.align()
  if (eph && data[hb.pos] === 0xff && data[hb.pos + 1] === 0x92) hb.pos += 2
  for (const f of found) {
    for (let j = 0; j < f.lens.length; j++) {
      const bytes = data.subarray(hb.pos, hb.pos + f.lens[j])
      hb.pos += f.lens[j]
      f.b.chunks.push(bytes)
      if (!termAll && f.b.segLens.length === 1) {
        f.b.segLens[0] += f.lens[j]
        f.b.segPasses[0] += f.passes[j]
      } else {
        f.b.segLens.push(f.lens[j])
        f.b.segPasses.push(f.passes[j])
      }
      f.b.passes += f.passes[j]
    }
  }
}

function reconstruct(cc: ReturnType<typeof buildComponent>, comp: Comp): Int32Array {
  const { res, coding, tc } = cc
  const style = coding.style
  const rev = coding.reversible
  // Decode every code-block into its band's coefficients.
  const bandData = res.map((r) =>
    r.bands.map((band) => {
      const w = band.x1 - band.x0
      const h = band.y1 - band.y0
      const a = new Float64Array(Math.max(0, w * h))
      for (const b of band.blocks) {
        const { v } = decodeBlock(b, band.orient === 1 ? 1 : band.orient === 3 ? 2 : 0, band.mb, style)
        const bw = b.x1 - b.x0
        for (let y = b.y0; y < b.y1; y++) {
          for (let x = b.x0; x < b.x1; x++) {
            const q = v[(y - b.y0) * bw + (x - b.x0)]
            a[(y - band.y0) * w + (x - band.x0)] = rev ? q : q * band.step
          }
        }
      }
      return a
    }),
  )
  // Inverse DWT, resolution by resolution (Annex F: interleave, rows, columns).
  let cur = bandData[0][0]
  let cw = res[0].x1 - res[0].x0
  let chh = res[0].y1 - res[0].y0
  const tmp = new Float64Array(Math.max(cw, chh, tc.x1 - tc.x0, tc.y1 - tc.y0) + 16)
  for (let r = 1; r < res.length; r++) {
    const R = res[r]
    const w = R.x1 - R.x0
    const h = R.y1 - R.y0
    const img = new Float64Array(w * h)
    const [HL, LH, HH] = bandData[r]
    const bHL = R.bands[0]
    const bLH = R.bands[1]
    const bHH = R.bands[2]
    const lx0 = Math.ceil(R.x0 / 2)
    const ly0 = Math.ceil(R.y0 / 2)
    const hx0 = Math.floor(R.x0 / 2)
    const hy0 = Math.floor(R.y0 / 2)
    for (let y = 0; y < h; y++) {
      const uy = R.y0 + y
      for (let x = 0; x < w; x++) {
        const ux = R.x0 + x
        const evenX = (ux & 1) === 0
        const evenY = (uy & 1) === 0
        let v = 0
        if (evenX && evenY) v = cur[(uy / 2 - ly0) * cw + (ux / 2 - lx0)]
        else if (!evenX && evenY) v = HL[((uy / 2) - (bHL.y0)) * (bHL.x1 - bHL.x0) + ((ux - 1) / 2 - hx0)]
        else if (evenX && !evenY) v = LH[((uy - 1) / 2 - hy0) * (bLH.x1 - bLH.x0) + (ux / 2 - bLH.x0)]
        else v = HH[((uy - 1) / 2 - hy0) * (bHH.x1 - bHH.x0) + ((ux - 1) / 2 - hx0)]
        img[y * w + x] = v ?? 0
      }
    }
    const row = new Float64Array(w)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) row[x] = img[y * w + x]
      inverse1d(row, w, R.x0, rev, tmp)
      for (let x = 0; x < w; x++) img[y * w + x] = row[x]
    }
    const col = new Float64Array(h)
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) col[y] = img[y * w + x]
      inverse1d(col, h, R.y0, rev, tmp)
      for (let y = 0; y < h; y++) img[y * w + x] = col[y]
    }
    cur = img
    cw = w
    chh = h
  }
  void chh
  // DC level shift and the component's range.
  const n = (tc.x1 - tc.x0) * (tc.y1 - tc.y0)
  const out = new Int32Array(n)
  const shift = comp.signed ? 0 : 2 ** (comp.prec - 1)
  const lo = comp.signed ? -(2 ** (comp.prec - 1)) : 0
  const hi = comp.signed ? 2 ** (comp.prec - 1) - 1 : 2 ** comp.prec - 1
  for (let i = 0; i < n; i++) {
    const v = Math.round((cur[i] ?? 0) + shift)
    out[i] = v < lo ? lo : v > hi ? hi : v
  }
  return out
}
