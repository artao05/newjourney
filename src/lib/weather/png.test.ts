import { describe, expect, it } from 'vitest'
import { decodePng } from './png'
import { encodePng } from './fixtures/png'

describe('PNG', () => {
  it.each([
    [8, 0, 1, 1],
    [16, 0, 1, 2],
    [8, 2, 3, 3],
    [8, 6, 4, 4],
  ])('undoes every filter at depth %i, colour type %i', (depth, colour, channels, bpp) => {
    const w = 13
    const h = 11
    const rows = new Uint8Array(w * h * bpp)
    for (let i = 0; i < rows.length; i++) rows[i] = (i * 37 + (i >> 3) * 11) & 255
    const img = decodePng(encodePng(w, h, depth, colour, rows, bpp))
    expect([img.width, img.height, img.bitDepth, img.channels, img.rowBytes]).toEqual([w, h, depth, channels, w * bpp])
    expect(img.rows).toEqual(rows)
  })

  it('refuses what it does not read', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/)
    const rows = new Uint8Array(4)
    const interlaced = encodePng(2, 2, 8, 0, rows, 1)
    interlaced[8 + 8 + 12] = 1
    expect(() => decodePng(interlaced)).toThrow(/interlaced/)
  })
})
