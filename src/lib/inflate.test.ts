import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inflateRaw, inflateZlib } from './inflate'

function sample(n: number, seed = 1): Uint8Array {
  // Compressible but not trivial: words from a small vocabulary with noise.
  const words = ['wind', 'tack', 'gybe', 'mark', 'layline', 'current', 'polar', ' ', '\n', '0123']
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const out: number[] = []
  while (out.length < n) {
    const w = words[Math.floor(rnd() * words.length)]
    for (const ch of w) out.push(ch.charCodeAt(0))
    if (rnd() < 0.05) out.push(Math.floor(rnd() * 256))
  }
  return new Uint8Array(out.slice(0, n))
}

describe('inflate', () => {
  it.each([0, 1, 6, 9])('reads what zlib writes at level %i', (level) => {
    const data = sample(50_000, level + 3)
    expect(inflateZlib(new Uint8Array(deflateSync(data, { level })))).toEqual(data)
    expect(inflateRaw(new Uint8Array(deflateRawSync(data, { level })))).toEqual(data)
  })

  it('reads fixed-Huffman blocks, long back-references and empty input', () => {
    expect(inflateZlib(new Uint8Array(deflateSync(new Uint8Array(0))))).toEqual(new Uint8Array(0))
    const tiny = new TextEncoder().encode('abc')
    expect(inflateRaw(new Uint8Array(deflateRawSync(tiny)))).toEqual(tiny)
    const runs = new Uint8Array(200_000).fill(7)
    expect(inflateZlib(new Uint8Array(deflateSync(runs)), 16)).toEqual(runs)
  })

  it('reads random bytes, which zlib stores or codes dynamically', () => {
    const r = new Uint8Array(30_000)
    let s = 99
    for (let i = 0; i < r.length; i++) r[i] = (s = (s * 1664525 + 1013904223) >>> 0) >>> 24
    expect(inflateZlib(new Uint8Array(deflateSync(r)))).toEqual(r)
  })

  it('says what is wrong with a bad stream rather than returning rubbish', () => {
    const good = new Uint8Array(deflateSync(sample(5000)))
    expect(() => inflateZlib(good.subarray(0, good.length - 200))).toThrow(/ends early/)
    expect(() => inflateZlib(new Uint8Array([1, 2, 3]))).toThrow(/not a zlib stream/)
    expect(() => inflateRaw(new Uint8Array([0x07]))).toThrow(/block type/)
  })
})
