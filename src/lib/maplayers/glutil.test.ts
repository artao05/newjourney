/**
 * Tests for the field encoders and time indexing.
 *
 * These run in Node with no WebGL context, which is deliberate: the encoding is
 * where the real bugs live (sign conventions, missing-data handling, quantisation),
 * and it is pure data in, data out. Shader behaviour is verified in the browser.
 */

import { describe, expect, it } from 'vitest'
import { encodeScalarField, encodeVectorField, timeIndices } from './glutil'

describe('encodeVectorField', () => {
  it('maps the observed range across the full byte span', () => {
    const u = new Float32Array([-10, 0, 10, 5])
    const v = new Float32Array([0, 5, -5, 10])
    const e = encodeVectorField(u, v, 2, 2, 0)

    expect(e.uMin).toBe(-10)
    expect(e.uMax).toBe(10)
    expect(e.vMin).toBe(-5)
    expect(e.vMax).toBe(10)
    // u = -10 is the minimum, so it encodes to 0; u = 10 to 255.
    expect(e.data[0]).toBe(0)
    expect(e.data[2 * 4]).toBe(255)
  })

  it('marks missing cells with zero alpha rather than zero wind', () => {
    const u = new Float32Array([5, NaN])
    const v = new Float32Array([5, NaN])
    const e = encodeVectorField(u, v, 2, 1, 0)

    expect(e.data[3]).toBe(255) // covered
    expect(e.data[7]).toBe(0) // not covered
  })

  it('survives a constant field without dividing by zero', () => {
    const u = new Float32Array([7, 7, 7, 7])
    const v = new Float32Array([3, 3, 3, 3])
    const e = encodeVectorField(u, v, 2, 2, 0)

    expect(e.uMax).toBeGreaterThan(e.uMin)
    expect(e.vMax).toBeGreaterThan(e.vMin)
    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(e.data[i * 4])).toBe(true)
      expect(e.data[i * 4 + 3]).toBe(255)
    }
  })

  it('survives an entirely missing field', () => {
    const u = new Float32Array([NaN, NaN])
    const v = new Float32Array([NaN, NaN])
    const e = encodeVectorField(u, v, 2, 1, 0)

    expect(Number.isFinite(e.uMin)).toBe(true)
    expect(Number.isFinite(e.magMax)).toBe(true)
    expect(e.magMax).toBeGreaterThan(0)
    expect(e.data[3]).toBe(0)
    expect(e.data[7]).toBe(0)
  })

  it('reads the requested time slice, not always the first', () => {
    // Two time steps of a 2x1 grid.
    const u = new Float32Array([1, 1, 100, 100])
    const v = new Float32Array([0, 0, 0, 0])
    const t0 = encodeVectorField(u, v, 2, 1, 0)
    const t1 = encodeVectorField(u, v, 2, 1, 2)

    expect(t0.magMax).toBeCloseTo(1, 6)
    expect(t1.magMax).toBeCloseTo(100, 6)
  })

  it('encodes magnitude into the blue channel', () => {
    const u = new Float32Array([0, 3])
    const v = new Float32Array([0, 4])
    const e = encodeVectorField(u, v, 2, 1, 0)

    expect(e.magMax).toBeCloseTo(5, 6)
    expect(e.data[2]).toBe(0) // zero wind
    expect(e.data[6]).toBe(255) // the fastest cell
  })
})

describe('encodeScalarField', () => {
  it('round-trips through 16-bit quantisation within tolerance', () => {
    const s = new Float32Array([1000, 1005, 1010, 1015])
    const e = encodeScalarField(s, 2, 2, 0)

    const decode = (i: number) => {
      const hi = e.data[i * 4]
      const lo = e.data[i * 4 + 1]
      const norm = (hi * 256 + lo) / 65535
      return e.min + norm * (e.max - e.min)
    }
    for (let i = 0; i < 4; i++) {
      expect(decode(i)).toBeCloseTo(s[i], 2)
    }
  })

  it('uses 16 bits, so a few millibars out of 1000 survive', () => {
    // 8-bit encoding of a 15 mb span would quantise to ~0.06 mb steps; the point
    // is that the two adjacent values remain distinguishable.
    const s = new Float32Array([1012.3, 1012.4])
    const e = encodeScalarField(s, 2, 1, 0)
    const a = e.data[0] * 256 + e.data[1]
    const b = e.data[4] * 256 + e.data[5]
    expect(a).not.toBe(b)
  })

  it('honours an explicit domain instead of the data range', () => {
    const s = new Float32Array([2, 4])
    const e = encodeScalarField(s, 2, 1, 0, [0, 8])
    expect(e.min).toBe(0)
    expect(e.max).toBe(8)
  })

  it('flags missing cells with zero alpha', () => {
    const s = new Float32Array([1, NaN])
    const e = encodeScalarField(s, 2, 1, 0)
    expect(e.data[3]).toBe(255)
    expect(e.data[7]).toBe(0)
  })
})

describe('timeIndices', () => {
  const t0 = 1_000_000
  const dt = 3_600_000

  it('returns the bracketing steps and the fraction between', () => {
    const r = timeIndices(t0, dt, 5, t0 + dt * 2.25)
    expect(r.i0).toBe(2)
    expect(r.i1).toBe(3)
    expect(r.frac).toBeCloseTo(0.25, 6)
  })

  it('lands exactly on a step with zero fraction', () => {
    const r = timeIndices(t0, dt, 5, t0 + dt * 3)
    expect(r.i0).toBe(3)
    expect(r.frac).toBeCloseTo(0, 6)
  })

  it('clamps before the start and after the end', () => {
    const before = timeIndices(t0, dt, 5, t0 - dt * 10)
    expect(before.i0).toBe(0)
    expect(before.frac).toBe(0)

    const after = timeIndices(t0, dt, 5, t0 + dt * 99)
    expect(after.i0).toBe(4)
    expect(after.i1).toBe(4)
    expect(after.frac).toBe(0)
  })

  it('handles a single-step cube', () => {
    const r = timeIndices(t0, dt, 1, t0 + dt * 5)
    expect(r).toEqual({ i0: 0, i1: 0, frac: 0 })
  })

  it('refuses a non-finite header rather than passing NaN to the shader', () => {
    /*
     * Every value here becomes a uniform. `Math.min`/`Math.max` return NaN
     * unchanged and `NaN <= 1` is false, so a cube whose header did not survive
     * decoding used to produce `{ i0: NaN, i1: NaN, frac: NaN }` — which throws
     * nothing, warns nothing, and draws a layer that is silently wrong.
     */
    for (const [label, args] of [
      ['NaN t', [t0, dt, 5, Number.NaN]],
      ['NaN t0', [Number.NaN, dt, 5, t0]],
      ['NaN dtMs', [t0, Number.NaN, 5, t0]],
      ['NaN nt', [t0, dt, Number.NaN, t0]],
      ['infinite t', [t0, dt, 5, Number.POSITIVE_INFINITY]],
    ] as Array<[string, [number, number, number, number]]>) {
      const r = timeIndices(...args)
      expect(r, label).toEqual({ i0: 0, i1: 0, frac: 0 })
    }
  })

  it('still brackets normally when only the clock is at an extreme', () => {
    // The guard must not swallow the ordinary out-of-range case, which has its
    // own correct answer: pinned to an end, not reset to the start.
    expect(timeIndices(t0, dt, 5, t0 + dt * 99)).toEqual({ i0: 4, i1: 4, frac: 0 })
  })
})
