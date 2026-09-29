/**
 * Test fixtures: a CCSDS 121.0-B encoder, so tests can build the streams GRIB
 * template 5.42 carries. It picks the cheapest option for each block, as libaec
 * does, or the one `force` names, so every coding option can be exercised.
 */
import { AEC_DATA_PREPROCESS, AEC_DATA_SIGNED, AEC_PAD_RSI, AEC_RESTRICTED, type AecOptions } from '../aec'

class Writer {
  out: number[] = []
  private acc = 0
  private n = 0
  put(v: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(v / 2 ** i) & 1)
      if (++this.n === 8) {
        this.out.push(this.acc)
        this.acc = 0
        this.n = 0
      }
    }
  }
  fs(v: number) {
    for (let i = 0; i < v; i++) this.put(0, 1)
    this.put(1, 1)
  }
  align() {
    if (this.n) this.put(0, 8 - this.n)
  }
}

export type AecForce = 'split' | 'se' | 'uncomp'

export function aecEncode(samples: number[], o: AecOptions & { force?: AecForce }): Uint8Array {
  const n = o.bitsPerSample
  const J = o.blockSize
  const pp = (o.flags & AEC_DATA_PREPROCESS) !== 0
  const signed = (o.flags & AEC_DATA_SIGNED) !== 0
  const idLen = o.flags & AEC_RESTRICTED && n <= 4 ? (n <= 2 ? 1 : 2) : n > 16 ? 5 : n > 8 ? 4 : 3
  const idMax = (1 << idLen) - 1
  const xmin = signed ? -(2 ** (n - 1)) : 0
  const xmax = signed ? 2 ** (n - 1) - 1 : 2 ** n - 1
  const raw = (v: number) => (v < 0 ? v + 2 ** n : v)
  const w = new Writer()
  const per = o.rsi * J
  for (let s0 = 0; s0 < samples.length; s0 += per) {
    if (s0 > 0 && o.flags & AEC_PAD_RSI) w.align()
    const chunk = samples.slice(s0, s0 + per)
    let vals: number[]
    if (pp) {
      vals = [raw(chunk[0])]
      for (let i = 1; i < chunk.length; i++) {
        const pred = chunk[i - 1]
        const delta = chunk[i] - pred
        const theta = Math.min(pred - xmin, xmax - pred)
        vals.push(delta >= 0 && delta <= theta ? 2 * delta : delta < 0 && -delta <= theta ? -2 * delta - 1 : theta + Math.abs(delta))
      }
    } else vals = chunk.map(raw)
    const nb = Math.ceil(vals.length / J)
    while (vals.length < nb * J) vals.push(0)
    for (let b = 0; b < nb; ) {
      const ref = pp && b === 0
      const blk = vals.slice(b * J, (b + 1) * J)
      const res = ref ? blk.slice(1) : blk
      if (!o.force && res.every((v) => v === 0)) {
        const segEnd = (Math.floor(b / 64) + 1) * 64
        let L = 1
        while (b + L < Math.min(nb, segEnd) && vals.slice((b + L) * J, (b + L + 1) * J).every((v) => v === 0)) L++
        w.put(0, idLen)
        w.put(0, 1)
        if (ref) w.put(blk[0], n)
        if (b + L === Math.min(o.rsi, segEnd) && L >= 5) w.fs(4)
        else w.fs(L <= 4 ? L - 1 : L)
        b += L
        continue
      }
      const pairs: Array<[number, number]> = []
      for (let i = ref ? -1 : 0; i < res.length; i += 2) pairs.push([i < 0 ? 0 : res[i], res[i + 1]])
      const gamma = ([a, c]: [number, number]) => ((a + c) * (a + c + 1)) / 2 + c
      const seCost = pairs.reduce((t, p) => t + gamma(p) + 1, 0)
      let bestK = 0
      let bestCost = Infinity
      for (let k = 0; k <= Math.min(idMax - 2, n); k++) {
        const c = res.reduce((t, v) => t + Math.floor(v / 2 ** k) + 1 + k, 0)
        if (c < bestCost) [bestK, bestCost] = [k, c]
      }
      const choice = o.force ?? (n * J <= Math.min(bestCost, seCost) ? 'uncomp' : seCost < bestCost ? 'se' : 'split')
      if (choice === 'uncomp') {
        w.put(idMax, idLen)
        for (const v of blk) w.put(v, n)
      } else if (choice === 'se') {
        w.put(0, idLen)
        w.put(1, 1)
        if (ref) w.put(blk[0], n)
        for (const p of pairs) w.fs(gamma(p))
      } else {
        w.put(bestK + 1, idLen)
        if (ref) w.put(blk[0], n)
        for (const v of res) w.fs(Math.floor(v / 2 ** bestK))
        if (bestK) for (const v of res) w.put(v % 2 ** bestK, bestK)
      }
      b++
    }
  }
  w.align()
  return new Uint8Array(w.out)
}
