/**
 * Colour ramp tests.
 *
 * Expected colours are stated as literal RGB triples worked out by hand from the
 * hex stops in colormap.ts, so a changed ramp fails loudly instead of a test
 * quietly agreeing with whatever the code now does. The Beaufort boundaries in
 * particular are the published scale (docs/07-map-layers/render-architecture.md
 * §3) and not a restatement of the implementation.
 */

import { describe, expect, it } from 'vitest'
import type { ColorRamp } from './types'
import {
  LAYERS,
  RAMPS,
  beaufortForce,
  makeSampler,
  rampFor,
  rampToCssGradient,
  rampToLUT,
  rampToMapLibreExpression,
} from './colormap'

/** RGB of the LUT entry at index i. */
function lutRgba(lut: Uint8Array, i: number): [number, number, number, number] {
  return [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2], lut[i * 4 + 3]]
}

describe('RAMPS', () => {
  it('provides every ramp the spec requires', () => {
    for (const id of ['wind', 'beaufort', 'wave', 'sst', 'rain', 'current']) {
      expect(RAMPS[id], id).toBeDefined()
      expect(RAMPS[id].id).toBe(id)
    }
  })

  it('has strictly ascending stop values and in-gamut colours', () => {
    for (const [id, ramp] of Object.entries(RAMPS)) {
      expect(ramp.stops.length, id).toBeGreaterThan(1)
      for (let i = 1; i < ramp.stops.length; i++) {
        expect(ramp.stops[i].value, `${id} stop ${i}`).toBeGreaterThan(ramp.stops[i - 1].value)
      }
      for (const s of ramp.stops) {
        for (const c of s.rgb) {
          expect(Number.isInteger(c), id).toBe(true)
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(255)
        }
      }
    }
  })

  it('marks only Beaufort as discrete', () => {
    expect(RAMPS.beaufort.discrete).toBe(true)
    expect(RAMPS.wind.discrete).toBeFalsy()
    expect(RAMPS.wave.discrete).toBeFalsy()
  })

  it('is not a rainbow for wind: lightness rises monotonically', () => {
    // Rec. 709 luma. The point of viridis is that this never reverses, so the
    // eye never reads an edge the data does not have.
    const luma = (rgb: [number, number, number]) =>
      0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    const ls = RAMPS.wind.stops.map((s) => luma(s.rgb))
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1])
  })
})

describe('makeSampler', () => {
  const wind = makeSampler(RAMPS.wind)

  it('returns the stop colour exactly on a stop', () => {
    expect(wind(0)).toEqual([68, 1, 84]) // #440154
    expect(wind(5)).toEqual([70, 51, 126]) // #46337e
    expect(wind(50)).toEqual([253, 231, 37]) // #fde725
  })

  it('interpolates linearly between stops', () => {
    // Halfway from #440154 (68,1,84) to #46337e (70,51,126).
    expect(wind(2.5)).toEqual([69, 26, 105])
    // 25 kn is 0.625 of the way from 20 kn #1fa187 (31,161,135)
    // to 28 kn #4ac16d (74,193,109).
    expect(wind(25)).toEqual([58, 181, 119])
  })

  it('clamps outside the stop range instead of extrapolating', () => {
    expect(wind(-99)).toEqual([68, 1, 84])
    expect(wind(999)).toEqual([253, 231, 37])
  })

  it('clamps a non-finite value to the low end', () => {
    // Documented last resort: missing data must be rejected before it gets here.
    expect(wind(NaN)).toEqual([68, 1, 84])
  })

  it('does not blend across a discrete class', () => {
    const bft = makeSampler(RAMPS.beaufort)
    // 19 kn is force 5, #8fd646, and must not be tinted toward force 6.
    expect(bft(17)).toEqual([143, 214, 70])
    expect(bft(19)).toEqual([143, 214, 70])
    expect(bft(21.9)).toEqual([143, 214, 70])
    expect(bft(22)).not.toEqual([143, 214, 70])
  })
})

describe('beaufortForce', () => {
  it('puts every published boundary in the right force', () => {
    // Boundaries: 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64 kn.
    const cases: Array<[number, number]> = [
      [0, 0],
      [0.9, 0],
      [1, 1],
      [3.9, 1],
      [4, 2],
      [6.9, 2],
      [7, 3],
      [10.9, 3],
      [11, 4],
      [16.9, 4],
      [17, 5],
      [21.9, 5],
      [22, 6],
      [27.9, 6],
      [28, 7],
      [33.9, 7],
      [34, 8],
      [40.9, 8],
      [41, 9],
      [47.9, 9],
      [48, 10],
      [55.9, 10],
      [56, 11],
      [63.9, 11],
      [64, 12],
      [200, 12],
    ]
    for (const [kn, force] of cases) expect(beaufortForce(kn), `${kn} kn`).toBe(force)
  })

  it('agrees with the discrete sampler class for class', () => {
    const bft = makeSampler(RAMPS.beaufort)
    for (let kn = 0; kn <= 80; kn += 0.5) {
      expect(bft(kn), `${kn} kn`).toEqual(RAMPS.beaufort.stops[beaufortForce(kn)].rgb)
    }
  })
})

describe('rampToLUT', () => {
  it('returns exactly width * 4 bytes', () => {
    expect(rampToLUT(RAMPS.wind, [0, 40]).length).toBe(256 * 4)
    expect(rampToLUT(RAMPS.wind, [0, 40], 8).length).toBe(32)
    expect(rampToLUT(RAMPS.wind, [0, 40], 1).length).toBe(4)
  })

  it('puts the domain endpoints at the first and last entry', () => {
    const lut = rampToLUT(RAMPS.wave, [0, 8], 16)
    expect(lutRgba(lut, 0)).toEqual([24, 15, 61, 255]) // #180f3d at 0 m
    expect(lutRgba(lut, 15)).toEqual([252, 253, 191, 255]) // #fcfdbf at 8 m
  })

  it('clamps a domain wider than the ramp rather than fading to black', () => {
    const lut = rampToLUT(RAMPS.wind, [-10, 200], 4)
    expect(lutRgba(lut, 0)).toEqual([68, 1, 84, 255])
    expect(lutRgba(lut, 3)).toEqual([253, 231, 37, 255])
  })

  it('carries straight alpha from the ramp, transparent at zero rain', () => {
    const lut = rampToLUT(RAMPS.rain, [0, 20], 256)
    expect(lutRgba(lut, 0)[3]).toBe(0)
    expect(lutRgba(lut, 255)[3]).toBe(255)
    // Straight, not premultiplied: the RGB at alpha 0 is still the ramp colour.
    expect(lutRgba(lut, 0).slice(0, 3)).toEqual([79, 195, 247])
  })

  it('interpolates alpha as well as colour', () => {
    // 0.05 mm/h is halfway from (0 mm/h, a=0) to (0.1 mm/h, a=40).
    const lut = rampToLUT(RAMPS.rain, [0.05, 0.05], 1)
    expect(lutRgba(lut, 0)[3]).toBe(20)
  })

  it('defaults alpha to opaque for ramps that do not set it', () => {
    const lut = rampToLUT(RAMPS.wind, [0, 40], 32)
    for (let i = 0; i < 32; i++) expect(lutRgba(lut, i)[3]).toBe(255)
  })

  it('emits only class colours for a discrete ramp', () => {
    const lut = rampToLUT(RAMPS.beaufort, [0, 64], 256)
    const allowed = new Set(RAMPS.beaufort.stops.map((s) => s.rgb.join(',')))
    for (let i = 0; i < 256; i++) {
      expect(allowed.has(lutRgba(lut, i).slice(0, 3).join(','))).toBe(true)
    }
  })

  it('rejects a width below one', () => {
    expect(() => rampToLUT(RAMPS.wind, [0, 40], 0)).toThrow(/width/)
  })
})

describe('rampToCssGradient', () => {
  it('spans 0% to 100% of the domain', () => {
    const g = rampToCssGradient(RAMPS.wind, [0, 40])
    expect(g.startsWith('linear-gradient(to right, ')).toBe(true)
    expect(g).toContain('rgb(68, 1, 84) 0%')
    expect(g).toContain('100%')
  })

  it('only emits stops inside the domain', () => {
    const g = rampToCssGradient(RAMPS.wind, [10, 20])
    expect(g).toContain('rgb(54, 92, 141) 0%') // #365c8d, the 10 kn stop
    expect(g).not.toContain('rgb(68, 1, 84)') // the 0 kn stop is off-scale
  })

  it('gives a discrete ramp hard edges by doubling each stop', () => {
    const g = rampToCssGradient(RAMPS.beaufort, [0, 64])
    // F0 runs from 0% to the F1 boundary and repeats its colour at both ends.
    const f0 = 'rgb(200, 232, 240)'
    expect(g).toContain(`${f0} 0%`)
    expect(g.split(f0).length - 1).toBe(2)
  })

  it('survives a zero-width domain', () => {
    expect(rampToCssGradient(RAMPS.wind, [12, 12])).toContain('linear-gradient')
  })

  it('emits rgba only where the ramp is translucent', () => {
    expect(rampToCssGradient(RAMPS.rain, [0, 20])).toContain('rgba(79, 195, 247, 0)')
    expect(rampToCssGradient(RAMPS.wind, [0, 40])).not.toContain('rgba(')
  })
})

describe('rampToMapLibreExpression', () => {
  it('builds an ascending interpolate for a continuous ramp', () => {
    const e = rampToMapLibreExpression(RAMPS.wind, [0, 40], 'kn')
    expect(e[0]).toBe('interpolate')
    expect(e[1]).toEqual(['linear'])
    expect(e[2]).toEqual(['get', 'kn'])
    const inputs = e.slice(3).filter((_, i) => i % 2 === 0) as number[]
    expect(inputs[0]).toBe(0)
    expect(inputs[inputs.length - 1]).toBe(40)
    for (let i = 1; i < inputs.length; i++) {
      expect(inputs[i], `input ${i}`).toBeGreaterThan(inputs[i - 1])
    }
  })

  it('never emits a stop outside the domain', () => {
    const e = rampToMapLibreExpression(RAMPS.wind, [10, 20], 'kn')
    const inputs = e.slice(3).filter((_, i) => i % 2 === 0) as number[]
    for (const v of inputs) {
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThanOrEqual(20)
    }
  })

  it('builds a step expression for a discrete ramp', () => {
    const e = rampToMapLibreExpression(RAMPS.beaufort, [0, 64], 'kn')
    expect(e[0]).toBe('step')
    expect(e[1]).toEqual(['get', 'kn'])
    expect(e[2]).toBe('rgb(200, 232, 240)') // F0 is the base output
    // First break is the F1 boundary, 1 kn, and 0 kn never appears as a break.
    expect(e[3]).toBe(1)
    const breaks = e.slice(3).filter((_, i) => i % 2 === 0) as number[]
    expect(breaks).toEqual([1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64])
  })

  it('reads the property it is given', () => {
    const e = rampToMapLibreExpression(RAMPS.current, [0, 5], 'drift')
    expect(e[2]).toEqual(['get', 'drift'])
  })
})

describe('LAYERS', () => {
  it('defines the layers the spec requires', () => {
    for (const id of ['wind', 'gust', 'waveHeight', 'current', 'pressure']) {
      expect(LAYERS[id], id).toBeDefined()
      expect(LAYERS[id].id).toBe(id)
    }
  })

  it('gives wind and current the right kinds, params and default modes', () => {
    expect(LAYERS.wind.kind).toBe('vector')
    expect(LAYERS.wind.params).toEqual(['u10', 'v10'])
    expect(LAYERS.wind.defaultMode).toBe('particles')
    expect(LAYERS.current.kind).toBe('vector')
    expect(LAYERS.current.params).toEqual(['uo', 'vo'])
    expect(LAYERS.current.defaultMode).toBe('arrows')
    expect(LAYERS.gust.params).toEqual(['gust'])
    expect(LAYERS.waveHeight.params).toEqual(['hs'])
    expect(LAYERS.pressure.params).toEqual(['prmsl'])
  })

  it('keeps every layer internally consistent', () => {
    for (const [id, layer] of Object.entries(LAYERS)) {
      expect(layer.id, id).toBe(id)
      expect(layer.params.length, id).toBe(layer.kind === 'vector' ? 2 : 1)
      expect(RAMPS[layer.ramp], `${id} ramp`).toBeDefined()
      expect(layer.domain[1], `${id} domain`).toBeGreaterThan(layer.domain[0])
      expect(layer.unit.length, id).toBeGreaterThan(0)
      // A scalar field has no direction to draw, so a display mode is nonsense.
      if (layer.kind === 'scalar') expect(layer.defaultMode, id).toBeUndefined()
    }
  })

  it('resolves a layer to its ramp', () => {
    expect(rampFor(LAYERS.waveHeight)).toBe(RAMPS.wave)
    const bogus: ColorRamp = rampFor({ ...LAYERS.wind, ramp: 'nope' })
    expect(bogus).toBe(RAMPS.wind)
  })
})
