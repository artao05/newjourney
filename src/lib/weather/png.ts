/**
 * Just enough PNG to read GRIB2 template 5.41: one image, not interlaced, whose
 * pixels are the packed integers. Returns the rows with their filters undone,
 * one after another, each padded to a whole octet as PNG stores them.
 */
import { inflateZlib } from '../inflate'

export interface PngImage {
  width: number
  height: number
  bitDepth: number
  channels: number
  /** Unfiltered scanlines, `rowBytes` each. */
  rows: Uint8Array
  rowBytes: number
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export function decodePng(b: Uint8Array): PngImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (b.length < 8 || sig.some((x, i) => b[i] !== x)) throw new Error('not a PNG image')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let at = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colour = 0
  let interlace = 0
  const idat: Uint8Array[] = []
  while (at + 8 <= b.length) {
    const len = v.getUint32(at)
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    const data = b.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = v.getUint32(at + 8)
      height = v.getUint32(at + 12)
      bitDepth = b[at + 16]
      colour = b[at + 17]
      interlace = b[at + 20]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!width || !height) throw new Error('the PNG has no image header')
  if (interlace) throw new Error('an interlaced PNG is not read')
  const channels = CHANNELS[colour]
  if (!channels) throw new Error(`PNG colour type ${colour} is not read`)
  const total = idat.reduce((n, d) => n + d.length, 0)
  const z = new Uint8Array(total)
  let k = 0
  for (const d of idat) {
    z.set(d, k)
    k += d.length
  }
  const bpp = Math.max(1, (channels * bitDepth) >> 3)
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
  const raw = inflateZlib(z, height * (rowBytes + 1))
  if (raw.length < height * (rowBytes + 1)) throw new Error('the PNG image data is short')
  const rows = new Uint8Array(height * rowBytes)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)]
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    const up = dst - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0
      const u = y > 0 ? rows[up + x] : 0
      const c = y > 0 && x >= bpp ? rows[up + x - bpp] : 0
      const r = raw[src + x]
      let out: number
      if (f === 0) out = r
      else if (f === 1) out = r + a
      else if (f === 2) out = r + u
      else if (f === 3) out = r + ((a + u) >> 1)
      else if (f === 4) {
        const p = a + u - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - u)
        const pc = Math.abs(p - c)
        out = r + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c)
      } else throw new Error(`PNG filter ${f} is not valid`)
      rows[dst + x] = out & 255
    }
  }
  return { width, height, bitDepth, channels, rows, rowBytes }
}
