/**
 * Property-based invariant tests.
 *
 * Instead of testing specific expected values, these test structural properties
 * that must hold for ALL inputs. When a hand-picked test passes, it proves one
 * case; when an invariant test passes, it proves the property over a sweep.
 */

import { describe, expect, it } from 'vitest'
import { angdiff, wrap180, wrap360, lerpBearing, twaFrom, courseFor } from './angles'
import { bearing, destination, distance } from './geo'
import { apparentToTrue, trueToApparent, groundToTrue, trueToGround, windToUV, uvToWind, correctForHeel, estimateCurrent } from './wind'

// Seeded pseudo-random for reproducible sweeps.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(42)
const randRange = (lo: number, hi: number) => lo + rng() * (hi - lo)

// ------------------------------------------------------------------- angles

describe('angle invariants', () => {
  it('wrap360 is idempotent for 1000 random angles', () => {
    for (let i = 0; i < 1000; i++) {
      const a = randRange(-1e6, 1e6)
      const once = wrap360(a)
      const twice = wrap360(once)
      expect(twice).toBe(once)
      expect(once).toBeGreaterThanOrEqual(0)
      expect(once).toBeLessThan(360)
    }
  })

  it('wrap180 is idempotent for 1000 random angles', () => {
    for (let i = 0; i < 1000; i++) {
      const a = randRange(-1e6, 1e6)
      const once = wrap180(a)
      const twice = wrap180(once)
      expect(twice).toBe(once)
      expect(once).toBeGreaterThan(-180)
      expect(once).toBeLessThanOrEqual(180)
    }
  })

  it('angdiff(a, b) + angdiff(b, a) = 0 except at ±180', () => {
    for (let i = 0; i < 1000; i++) {
      const a = randRange(0, 360)
      const b = randRange(0, 360)
      const ab = angdiff(a, b)
      const ba = angdiff(b, a)
      // At exactly 180° both are +180 (closed end), so the sum is 360, not 0.
      if (Math.abs(Math.abs(ab) - 180) < 1e-9) continue
      expect(ab + ba).toBeCloseTo(0, 9)
    }
  })

  it('twaFrom and courseFor are exact inverses', () => {
    for (let i = 0; i < 1000; i++) {
      const twd = randRange(0, 360)
      const course = randRange(0, 360)
      const twa = twaFrom(course, twd)
      const back = courseFor(twd, twa)
      expect(wrap180(back - course)).toBeCloseTo(0, 9)
    }
  })

  it('lerpBearing(a, b, 0) = a and lerpBearing(a, b, 1) = b', () => {
    for (let i = 0; i < 500; i++) {
      const a = randRange(0, 360)
      const b = randRange(0, 360)
      expect(wrap180(lerpBearing(a, b, 0) - a)).toBeCloseTo(0, 9)
      expect(wrap180(lerpBearing(a, b, 1) - b)).toBeCloseTo(0, 9)
    }
  })
})

// ------------------------------------------------------------------- geodesy

describe('geodesy invariants', () => {
  it('destination(a, bearing(a,b), distance(a,b)) ≈ b for 200 random pairs', () => {
    for (let i = 0; i < 200; i++) {
      const a = { lat: randRange(-85, 85), lon: randRange(-180, 180) }
      const b = { lat: randRange(-85, 85), lon: randRange(-180, 180) }
      const d = distance(a, b)
      if (d < 0.01 || d > 5000) continue
      const brg = bearing(a, b)
      const c = destination(a, brg, d)
      expect(distance(b, c)).toBeLessThan(0.01)
    }
  })

  it('distance is symmetric and non-negative', () => {
    for (let i = 0; i < 200; i++) {
      const a = { lat: randRange(-85, 85), lon: randRange(-180, 180) }
      const b = { lat: randRange(-85, 85), lon: randRange(-180, 180) }
      const ab = distance(a, b)
      const ba = distance(b, a)
      expect(ab).toBeGreaterThanOrEqual(0)
      expect(ab).toBeCloseTo(ba, 9)
    }
  })

  it('distance(a, a) = 0', () => {
    for (let i = 0; i < 100; i++) {
      const a = { lat: randRange(-85, 85), lon: randRange(-180, 180) }
      expect(distance(a, a)).toBeCloseTo(0, 12)
    }
  })
})

// ------------------------------------------------------------------- wind

describe('wind triangle invariants', () => {
  it('apparentToTrue → trueToApparent roundtrip for 500 random conditions', () => {
    for (let i = 0; i < 500; i++) {
      const awa = randRange(-170, 170)
      const aws = randRange(0.1, 50)
      const bsp = randRange(0.1, 15)
      const course = randRange(0, 360)
      const t = apparentToTrue({ awa, aws, bsp, course })
      const back = trueToApparent({ twa: t.twa, tws: t.tws, bsp })
      expect(back.aws).toBeCloseTo(aws, 6)
      expect(wrap180(back.awa - awa)).toBeCloseTo(0, 6)
    }
  })

  it('groundToTrue → trueToGround roundtrip for 500 random conditions', () => {
    for (let i = 0; i < 500; i++) {
      const gwd = randRange(0, 360)
      const gws = randRange(0.1, 40)
      const set = randRange(0, 360)
      const drift = randRange(0.01, 5)
      const t = groundToTrue({ gwd, gws, set, drift })
      if (t.tws < 1e-6) continue
      const g = trueToGround({ twd: t.twd, tws: t.tws, set, drift })
      expect(g.gws).toBeCloseTo(gws, 6)
      expect(wrap180(g.gwd - gwd)).toBeCloseTo(0, 4)
    }
  })

  it('windToUV → uvToWind roundtrip for all compass points', () => {
    for (let dir = 0; dir < 360; dir += 0.7) {
      for (const speed of [0.1, 5, 20, 50]) {
        const uv = windToUV(dir, speed)
        const back = uvToWind(uv.u, uv.v)
        expect(back.speed).toBeCloseTo(speed, 9)
        expect(wrap180(back.dirFrom - dir)).toBeCloseTo(0, 6)
      }
    }
  })

  it('heel correction is identity at heel=0 for all AWA/AWS', () => {
    for (let i = 0; i < 200; i++) {
      const awa = randRange(-170, 170)
      const aws = randRange(0.1, 50)
      const r = correctForHeel({ awa, aws, heelDeg: 0 })
      expect(r.aws).toBeCloseTo(aws, 12)
      expect(wrap180(r.awa - awa)).toBeCloseTo(0, 12)
    }
  })

  it('estimateCurrent with zero drift yields set=0, drift≈0', () => {
    for (let i = 0; i < 200; i++) {
      const cog = randRange(0, 360)
      const sog = randRange(0.5, 10)
      const r = estimateCurrent({ cog, sog, heading: cog, bsp: sog })
      expect(r).not.toBeNull()
      expect(r!.drift).toBeCloseTo(0, 9)
    }
  })

  it('TWS is always non-negative from apparentToTrue', () => {
    for (let i = 0; i < 500; i++) {
      const awa = randRange(-180, 180)
      const aws = randRange(0, 50)
      const bsp = randRange(0, 15)
      const r = apparentToTrue({ awa, aws, bsp, course: randRange(0, 360) })
      expect(r.tws).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(r.tws)).toBe(true)
      expect(Number.isFinite(r.twa)).toBe(true)
      expect(Number.isFinite(r.twd)).toBe(true)
    }
  })
})
