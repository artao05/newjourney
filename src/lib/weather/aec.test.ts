import { describe, expect, it } from 'vitest'
import { AEC_DATA_3BYTE, AEC_DATA_MSB, AEC_DATA_PREPROCESS, AEC_DATA_SIGNED, AEC_PAD_RSI, AEC_RESTRICTED, aecDecode } from './aec'
import { aecEncode, type AecForce } from './fixtures/aec'

/** A field with smooth stretches, flat stretches and noise, as a GRIB field has. */
function field(count: number, n: number, seed = 7, signed = false): number[] {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const lo = signed ? -(2 ** (n - 1)) : 0
  const hi = signed ? 2 ** (n - 1) - 1 : 2 ** n - 1
  const out: number[] = []
  let x = Math.floor((lo + hi) / 2)
  for (let i = 0; i < count; i++) {
    const phase = Math.floor(i / 97) % 4
    if (phase === 1) {
      // flat
    } else if (phase === 2) x = Math.floor(lo + rnd() * (hi - lo + 1))
    else x += Math.round((rnd() - 0.5) * Math.min(64, 2 ** (n - 2)))
    x = Math.max(lo, Math.min(hi, x))
    out.push(x)
  }
  return out
}

describe('CCSDS / AEC decoding', () => {
  it('reads a zero block with its reference sample, assembled by hand from the standard', () => {
    // n = 8, J = 8, r = 1, preprocessed, eight 10s: ID 000, selector 0, reference
    // 00001010, then one zero block, FS "1". 0000 0000 | 1010 1000.
    expect([...aecDecode(new Uint8Array([0x00, 0xa8]), 8, { bitsPerSample: 8, blockSize: 8, rsi: 1, flags: AEC_DATA_PREPROCESS })]).toEqual([10, 10, 10, 10, 10, 10, 10, 10])
  })

  const cases: Array<[string, number, number, number, number]> = [
    // label, bits a sample, block size, blocks per interval, flags
    ['ECMWF open data: 16 bits, J 32, r 128, MSB + preprocess', 16, 32, 128, AEC_DATA_MSB | AEC_DATA_PREPROCESS],
    ['24 bits in three bytes', 24, 32, 128, AEC_DATA_3BYTE | AEC_DATA_MSB | AEC_DATA_PREPROCESS],
    ['12 bits, J 16, short intervals', 12, 16, 3, AEC_DATA_PREPROCESS],
    ['8 bits, J 8, padded intervals', 8, 8, 5, AEC_DATA_PREPROCESS | AEC_PAD_RSI],
    ['no preprocessing', 10, 64, 16, 0],
    ['signed samples', 14, 32, 8, AEC_DATA_SIGNED | AEC_DATA_PREPROCESS],
    ['32 bits', 32, 16, 4, AEC_DATA_PREPROCESS],
    ['restricted, 4 bits', 4, 16, 16, AEC_RESTRICTED | AEC_DATA_PREPROCESS],
    ['restricted, 2 bits', 2, 8, 16, AEC_RESTRICTED | AEC_DATA_PREPROCESS],
  ]
  it.each(cases)('reads back what it was given: %s', (_label, n, J, rsi, flags) => {
    const signed = (flags & AEC_DATA_SIGNED) !== 0
    const x = field(5003, n, n * 31 + J, signed)
    const o = { bitsPerSample: n, blockSize: J, rsi, flags }
    expect([...aecDecode(aecEncode(x, o), x.length, o)]).toEqual(x)
  })

  it.each(['split', 'se', 'uncomp'] as AecForce[])('reads every block coded with the %s option', (force) => {
    const x = field(1000, 12, 3).map((v, i) => (force === 'se' ? 2000 + (i % 3) : v))
    const o = { bitsPerSample: 12, blockSize: 16, rsi: 4, flags: AEC_DATA_PREPROCESS }
    expect([...aecDecode(aecEncode(x, { ...o, force }), x.length, o)]).toEqual(x)
  })

  it('reads long flat runs, to the end of a 64-block segment and beyond', () => {
    const x = [...new Array(64 * 8 * 3 + 5).fill(300), 301, 299, ...new Array(700).fill(299)]
    const o = { bitsPerSample: 10, blockSize: 8, rsi: 128, flags: AEC_DATA_PREPROCESS }
    const bytes = aecEncode(x, o)
    expect(bytes.length).toBeLessThan(60)
    expect([...aecDecode(bytes, x.length, o)]).toEqual(x)
  })

  it('says so when the stream stops short', () => {
    const x = field(500, 16)
    const o = { bitsPerSample: 16, blockSize: 32, rsi: 128, flags: AEC_DATA_PREPROCESS }
    const bytes = aecEncode(x, o)
    expect(() => aecDecode(bytes.subarray(0, bytes.length >> 1), x.length, o)).toThrow(/ends early/)
    expect(() => aecDecode(bytes, 10, { ...o, blockSize: 12 })).toThrow(/block size/)
  })
})
