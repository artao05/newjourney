/**
 * Test fixture: a BSB/KAP raster chart written to the layout (see bsb.ts):
 * the header, Ctrl-Z and NUL, the depth byte, run-length rows each with its
 * row number, and the row index with its offset in the last four bytes.
 */

export interface KapOptions {
  width: number
  height: number
  depth: number
  /** The palette index at each pixel, from one. */
  pixel: (x: number, y: number) => number
  /** Header lines after BSB/ (KNP, RGB, REF, …). */
  lines: string[]
  /** Rows numbered from this (one in most files). */
  firstRow?: number
}

const vlq = (n: number): number[] => {
  const out = [n & 0x7f]
  n = Math.floor(n / 128)
  while (n > 0) {
    out.unshift(0x80 | (n & 0x7f))
    n = Math.floor(n / 128)
  }
  return out
}

function run(value: number, length: number, depth: number): number[] {
  const shift = 7 - depth
  const mask = (1 << shift) - 1
  let v = length - 1
  const groups: number[] = []
  while (v > mask) {
    groups.unshift(v & 0x7f)
    v = Math.floor(v / 128)
  }
  return [(groups.length ? 0x80 : 0) | (value << shift) | v, ...groups.map((g, i) => (i < groups.length - 1 ? 0x80 : 0) | g)]
}

export function kap(o: KapOptions): Uint8Array {
  const text = ['! test chart', 'VER/3.0', `BSB/NA=Test Harbour,NU=99999,RA=${o.width},${o.height},DU=254`, ...o.lines].join('\r\n') + '\r\n'
  const out: number[] = [...[...text].map((c) => c.charCodeAt(0)), 0x1a, 0x00, o.depth]
  const starts: number[] = []
  for (let y = 0; y < o.height; y++) {
    starts.push(out.length)
    out.push(...vlq(y + (o.firstRow ?? 1)))
    let x = 0
    while (x < o.width) {
      const v = o.pixel(x, y)
      let n = 1
      while (x + n < o.width && o.pixel(x + n, y) === v) n++
      out.push(...run(v, n, o.depth))
      x += n
    }
    out.push(0)
  }
  const index = out.length
  for (const s of starts) out.push((s >>> 24) & 255, (s >>> 16) & 255, (s >>> 8) & 255, s & 255)
  out.push((index >>> 24) & 255, (index >>> 16) & 255, (index >>> 8) & 255, index & 255)
  return new Uint8Array(out)
}
