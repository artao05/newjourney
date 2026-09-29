/** Test fixtures: a PNG writer, so tests can build the images GRIB 5.41 carries. */
import { deflateSync } from 'node:zlib'

const u32 = (x: number) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]
const chunk = (type: string, data: number[] | Uint8Array) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]

/** A PNG of `rows` (unfiltered bytes), filtering row y with filter y mod 5, split over two IDATs. */
export function encodePng(width: number, height: number, bitDepth: number, colour: number, rows: Uint8Array, bpp: number): Uint8Array {
  const rowBytes = rows.length / height
  const raw: number[] = []
  for (let y = 0; y < height; y++) {
    const f = y % 5
    raw.push(f)
    for (let x = 0; x < rowBytes; x++) {
      const r = rows[y * rowBytes + x]
      const a = x >= bpp ? rows[y * rowBytes + x - bpp] : 0
      const u = y > 0 ? rows[(y - 1) * rowBytes + x] : 0
      const c = y > 0 && x >= bpp ? rows[(y - 1) * rowBytes + x - bpp] : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = u
      else if (f === 3) pred = (a + u) >> 1
      else if (f === 4) {
        const p = a + u - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - u)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? u : c
      }
      raw.push((r - pred) & 255)
    }
  }
  const z = new Uint8Array(deflateSync(new Uint8Array(raw)))
  const half = z.length >> 1
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...u32(width), ...u32(height), bitDepth, colour, 0, 0, 0]),
    ...chunk('tEXt', [65, 0, 66]),
    ...chunk('IDAT', z.subarray(0, half)),
    ...chunk('IDAT', z.subarray(half)),
    ...chunk('IEND', []),
  ])
}
