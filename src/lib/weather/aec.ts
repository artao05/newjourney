/**
 * CCSDS 121.0-B lossless decompression (Adaptive Entropy Coding, "AEC", the
 * format of libaec and szip), as GRIB2 template 5.42 carries it: ECMWF's open
 * data, DWD and others pack their fields this way.
 *
 * The stream is blocks of J samples. With preprocessing on, the first block of
 * every reference sample interval (r blocks) starts with a raw reference
 * sample, and the rest are mapped prediction residuals. Each block opens with
 * an option ID:
 *
 *   0 + 0   zero blocks: a run of blocks that are all zero
 *   0 + 1   second extension: pairs of small values coded together
 *   1 … max−1  split sample: a unary high part and k raw low bits, k = ID − 1
 *   max     no compression: n raw bits a sample
 */

/** libaec's flags, which GRIB carries as they are. */
export const AEC_DATA_SIGNED = 1
export const AEC_DATA_3BYTE = 2
export const AEC_DATA_MSB = 4
export const AEC_DATA_PREPROCESS = 8
export const AEC_RESTRICTED = 16
export const AEC_PAD_RSI = 32

/** Remainder of segment: the zero-block run length that means "to the end of the 64-block segment". */
const ROS = 5

class Bits {
  private pos = 0
  constructor(private readonly b: Uint8Array) {}
  get(n: number): number {
    let x = 0
    while (n > 0) {
      const avail = 8 - (this.pos & 7)
      const take = avail < n ? avail : n
      const byte = this.b[this.pos >> 3]
      if (byte === undefined) throw new Error('the compressed data ends early')
      x = x * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1))
      n -= take
      this.pos += take
    }
    return x
  }
  /** A fundamental-sequence code: the number of zeros before the next one. */
  fs(): number {
    let n = 0
    for (;;) {
      const byte = this.b[this.pos >> 3]
      if (byte === undefined) throw new Error('the compressed data ends early')
      if ((byte >> (7 - (this.pos & 7))) & 1) {
        this.pos++
        return n
      }
      n++
      this.pos++
    }
  }
  align() {
    this.pos = Math.ceil(this.pos / 8) * 8
  }
}

export interface AecOptions {
  bitsPerSample: number
  blockSize: number
  rsi: number
  flags: number
}

/** Decode `count` samples. */
export function aecDecode(data: Uint8Array, count: number, o: AecOptions): Float64Array {
  const n = o.bitsPerSample
  const J = o.blockSize
  if (n < 1 || n > 32) throw new Error(`AEC with ${n} bits a sample is not valid`)
  if (![8, 16, 32, 64].includes(J) && !(o.flags & AEC_RESTRICTED)) throw new Error(`an AEC block size of ${J} is not valid`)
  const pp = (o.flags & AEC_DATA_PREPROCESS) !== 0
  const signed = (o.flags & AEC_DATA_SIGNED) !== 0
  const idLen = o.flags & AEC_RESTRICTED && n <= 4 ? (n <= 2 ? 1 : 2) : n > 16 ? 5 : n > 8 ? 4 : 3
  const idMax = (1 << idLen) - 1
  const xmin = signed ? -(2 ** (n - 1)) : 0
  const xmax = signed ? 2 ** (n - 1) - 1 : 2 ** n - 1
  const br = new Bits(data)
  const out = new Float64Array(count)
  let k = 0
  const rsiSamples = o.rsi * J

  while (k < count) {
    // One reference sample interval.
    if (k > 0 && o.flags & AEC_PAD_RSI) br.align()
    const start = k
    const buf: number[] = []
    const want = Math.min(rsiSamples, count - start)
    let block = 0
    while (buf.length < want) {
      const ref = pp && block === 0
      const id = br.get(idLen)
      if (id === 0) {
        const se = br.get(1)
        if (ref) buf.push(br.get(n))
        if (se) {
          for (let i = ref ? 1 : 0; i < J; ) {
            const m = br.fs()
            let beta = Math.floor((Math.sqrt(8 * m + 1) - 1) / 2)
            while ((beta * (beta + 1)) / 2 > m) beta--
            const d2 = m - (beta * (beta + 1)) / 2
            if ((i & 1) === 0) {
              buf.push(beta - d2)
              i++
            }
            buf.push(d2)
            i++
          }
          block++
        } else {
          let zb = br.fs() + 1
          if (zb === ROS) zb = Math.min(o.rsi - block, 64 - (block % 64))
          else if (zb > ROS) zb--
          for (let i = zb * J - (ref ? 1 : 0); i > 0; i--) buf.push(0)
          block += zb
        }
      } else if (id === idMax) {
        for (let i = 0; i < J; i++) buf.push(br.get(n))
        block++
      } else {
        const kk = id - 1
        if (ref) buf.push(br.get(n))
        const len = J - (ref ? 1 : 0)
        const hi: number[] = new Array(len)
        for (let i = 0; i < len; i++) hi[i] = br.fs()
        for (let i = 0; i < len; i++) buf.push(hi[i] * 2 ** kk + (kk ? br.get(kk) : 0))
        block++
      }
    }
    // Undo the prediction, sample by sample, from the reference.
    const take = Math.min(buf.length, want)
    if (!pp) {
      for (let i = 0; i < take; i++) out[k++] = signed && buf[i] >= 2 ** (n - 1) ? buf[i] - 2 ** n : buf[i]
      continue
    }
    let x = signed && buf[0] >= 2 ** (n - 1) ? buf[0] - 2 ** n : buf[0]
    out[k++] = x
    for (let i = 1; i < take; i++) {
      const d = buf[i]
      const theta = Math.min(x - xmin, xmax - x)
      if (d <= 2 * theta) x += d % 2 === 0 ? d / 2 : -(d + 1) / 2
      else x += theta === x - xmin ? d - theta : -(d - theta)
      out[k++] = x
    }
  }
  return out
}
