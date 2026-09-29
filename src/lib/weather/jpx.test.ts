import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeJpx } from './jpx'

/*
 * Codestreams written by OpenJPEG 2.5 (through Pillow; fixtures/j2k/make.py):
 * the decoder is checked against an encoder and a decoder it shares no code
 * with. Lossless cases must return the expected samples exactly: the source
 * image, or for the tiled ones OpenJPEG's own decoding, since Pillow hands
 * OpenJPEG a tiled image wrongly. Lossy ones must agree with OpenJPEG's
 * decoding to within one count of rounding.
 */
const dir = join(__dirname, 'fixtures', 'j2k')
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Array<{ name: string; width: number; height: number; lossless: boolean; bits: number; expected: string }>

function expected(name: string, n: number): Uint16Array {
  const b = readFileSync(join(dir, `${name}.raw`))
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) out[i] = b[2 * i] | (b[2 * i + 1] << 8)
  return out
}

describe('JPEG 2000 decoding, against OpenJPEG', () => {
  it.each(index.map((c) => [`${c.name} (against the ${c.expected === 'source' ? 'source image' : 'OpenJPEG decoding'})`, c] as const))('%s', (_name, c) => {
    const img = decodeJpx(new Uint8Array(readFileSync(join(dir, `${c.name}.j2k`))))
    expect([img.width, img.height, img.precision]).toEqual([c.width, c.height, c.bits])
    const want = expected(c.name, c.width * c.height)
    let worst = 0
    let first = -1
    for (let i = 0; i < want.length; i++) {
      const e = Math.abs(img.samples[i] - want[i])
      if (e > worst) worst = e
      if (e && first < 0) first = i
    }
    if (c.lossless) expect({ worst, first }).toEqual({ worst: 0, first: -1 })
    else expect(worst).toBeLessThanOrEqual(1)
  })

  it('says what it is not given', () => {
    expect(() => decodeJpx(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a JPEG 2000 codestream/)
  })
})
