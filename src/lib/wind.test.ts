/**
 * Tests for the wind triangle, heel, leeway, current and ground/true wind.
 * Expected values are worked by hand from docs/03-algorithms/navigation-math.md
 * §3–§5 and stated as literals, so a regression fails loudly instead of
 * agreeing with itself.
 */

import { describe, expect, it } from 'vitest'
import {
  apparentToTrue,
  correctForHeel,
  estimateCurrent,
  groundToTrue,
  leewayFrom,
  trueToApparent,
  trueToGround,
  uvToWind,
  windToUV,
} from './wind'

describe('apparentToTrue', () => {
  it('matches a hand-worked wind triangle', () => {
    // AWA 30°, AWS 20 kn, BSP 7 kn, course 000.
    //   awx = 20 cos30 = 17.320508 ; awy = 20 sin30 = 10
    //   twx = 17.320508 - 7 = 10.320508 ; twy = 10
    //   TWS = hypot = 14.370556 ; TWA = atan2(10, 10.320508) = 44.096369°
    //   TWD = course + TWA = 44.096369
    const r = apparentToTrue({ awa: 30, aws: 20, bsp: 7, course: 0 })
    expect(r.tws).toBeCloseTo(14.370556, 6)
    expect(r.twa).toBeCloseTo(44.096369, 6)
    expect(r.twd).toBeCloseTo(44.096369, 6)
  })

  it('carries the tack sign through and wraps TWD onto the compass', () => {
    // Port tack: wind on the port bow, so AWA and TWA are both negative.
    const r = apparentToTrue({ awa: -30, aws: 20, bsp: 7, course: 10 })
    expect(r.twa).toBeCloseTo(-44.096369, 6)
    // 10 - 44.096 = -34.096 -> 325.903...
    expect(r.twd).toBeCloseTo(325.903631, 6)
  })

  it('reports the true wind dead astern when the boat outruns a following wind', () => {
    // TWS 5 from astern, boat doing 8: apparent is 3 kn from ahead.
    const r = apparentToTrue({ awa: 0, aws: 3, bsp: 8, course: 90 })
    expect(r.tws).toBeCloseTo(5, 9)
    expect(Math.abs(r.twa)).toBeCloseTo(180, 9)
  })
})

describe('trueToApparent', () => {
  it('round-trips with apparentToTrue', () => {
    for (const awa of [-150, -95, -42, -5, 0, 12, 60, 118, 175]) {
      const aws = 14
      const bsp = 6.2
      const course = 137
      const t = apparentToTrue({ awa, aws, bsp, course })
      const back = trueToApparent({ twa: t.twa, tws: t.tws, bsp })
      expect(back.awa).toBeCloseTo(awa, 9)
      expect(back.aws).toBeCloseTo(aws, 9)
    }
  })

  it('adds boat speed to the wind when hard on the wind', () => {
    const r = trueToApparent({ twa: 45, tws: 12, bsp: 6 })
    // awx = 12 cos45 + 6 = 14.485281 ; awy = 12 sin45 = 8.485281
    expect(r.aws).toBeCloseTo(Math.hypot(12 * Math.cos(Math.PI / 4) + 6, 12 * Math.sin(Math.PI / 4)), 9)
    expect(r.aws).toBeGreaterThan(12)
    expect(r.awa).toBeLessThan(45) // apparent draws forward
  })
})

describe('correctForHeel', () => {
  it('raises the transverse component, so AWS, AWA and TWS all go up', () => {
    // AWA 30, AWS 18, heel 20:
    //   awy = 9 -> 9 / cos20 = 9.577580 ; awx = 15.588457
    //   aws' = 18.294958 ; awa' = 31.567°
    const c = correctForHeel({ awa: 30, aws: 18, heelDeg: 20 })
    expect(c.aws).toBeCloseTo(18.295639, 5)
    expect(c.awa).toBeCloseTo(31.566704, 5)
    expect(c.aws).toBeGreaterThan(18)

    const raw = apparentToTrue({ awa: 30, aws: 18, bsp: 6, course: 0 })
    const corrected = apparentToTrue({ awa: c.awa, aws: c.aws, bsp: 6, course: 0 })
    expect(raw.tws).toBeCloseTo(13.150609, 5)
    expect(corrected.tws).toBeGreaterThan(raw.tws)
    expect(corrected.tws).toBeCloseTo(13.552451, 5)
  })

  it('is a no-op upright and symmetric in the sign of heel', () => {
    const flat = correctForHeel({ awa: 35, aws: 15, heelDeg: 0 })
    expect(flat.awa).toBeCloseTo(35, 9)
    expect(flat.aws).toBeCloseTo(15, 9)
    const port = correctForHeel({ awa: 35, aws: 15, heelDeg: -18 })
    const stbd = correctForHeel({ awa: 35, aws: 15, heelDeg: 18 })
    expect(port.aws).toBeCloseTo(stbd.aws, 12)
  })
})

describe('leewayFrom', () => {
  it('uses k · heel / bsp² and keeps the sign convention', () => {
    // k = 10, heel +12 (starboard heel, i.e. port tack), bsp 5 -> 10*12/25 = 4.8
    expect(leewayFrom({ heelDeg: 12, bsp: 5 })).toBeCloseTo(4.8, 9)
    // Positive leeway is clockwise, which is what port tack makes. Starboard
    // tack heels to port (negative heel) and so makes negative leeway.
    expect(leewayFrom({ heelDeg: -12, bsp: 5 })).toBeCloseTo(-4.8, 9)
    expect(leewayFrom({ heelDeg: 12, bsp: 5, k: 8 })).toBeCloseTo(3.84, 9)
  })

  it('falls to zero at low speed rather than diverging', () => {
    expect(leewayFrom({ heelDeg: 20, bsp: 0 })).toBe(0)
    expect(leewayFrom({ heelDeg: 20, bsp: 0.4 })).toBe(0)
  })
})

describe('estimateCurrent', () => {
  it('recovers a known current vector', () => {
    // Water track: 6 kn due north. Current: 3 kn setting east (090).
    // Ground track = (3, 6) -> COG 26.565051°, SOG 6.708204 kn.
    const c = estimateCurrent({ cog: 26.565051, sog: 6.708204, heading: 0, bsp: 6 })
    expect(c).not.toBeNull()
    expect(c!.set).toBeCloseTo(90, 4)
    expect(c!.drift).toBeCloseTo(3, 5)
  })

  it('accounts for leeway in the water track', () => {
    // Same boat, but making 5° of leeway: the water track is 005, not 000,
    // so part of what looked like an easterly set is the boat sliding sideways.
    const withLeeway = estimateCurrent({
      cog: 26.565051,
      sog: 6.708204,
      heading: 0,
      bsp: 6,
      leeway: 5,
    })!
    const without = estimateCurrent({ cog: 26.565051, sog: 6.708204, heading: 0, bsp: 6 })!
    expect(withLeeway.drift).toBeLessThan(without.drift)
    expect(withLeeway.drift).toBeCloseTo(2.477171, 5)
  })

  it('returns null above the ROT gate and computes below it', () => {
    const base = { cog: 26.565051, sog: 6.708204, heading: 0, bsp: 6 }
    expect(estimateCurrent({ ...base, rotDegPerSec: 9 })).toBeNull()
    expect(estimateCurrent({ ...base, rotDegPerSec: -9 })).toBeNull()
    expect(estimateCurrent({ ...base, rotDegPerSec: 1.2 })).not.toBeNull()
    // The gate is configurable.
    expect(estimateCurrent({ ...base, rotDegPerSec: 1.2, rotLimit: 0.5 })).toBeNull()
    expect(estimateCurrent({ ...base, rotDegPerSec: 9, rotLimit: 20 })).not.toBeNull()
  })

  it('reports zero drift with a defined set when the tracks agree', () => {
    const c = estimateCurrent({ cog: 45, sog: 5, heading: 45, bsp: 5 })!
    expect(c.drift).toBeCloseTo(0, 9)
    expect(Number.isFinite(c.set)).toBe(true)
  })
})

describe('ground wind vs true wind', () => {
  it('subtracts the current vector going from ground to true', () => {
    // Ground wind 10 kn from 000 (blowing toward 180); current 5 kn setting 090.
    // TW = GW - current = (0,-10) - (5,0) = (-5,-10), blowing toward 206.565,
    // i.e. FROM 026.565, at 11.180340 kn.
    const t = groundToTrue({ gwd: 0, gws: 10, set: 90, drift: 5 })
    expect(t.twd).toBeCloseTo(26.565051, 6)
    expect(t.tws).toBeCloseTo(11.18034, 6)
  })

  it('gives less true wind when the current runs downwind with the breeze', () => {
    // 3 kn of water running the way the wind blows removes 3 kn of true wind.
    const t = groundToTrue({ gwd: 0, gws: 10, set: 180, drift: 3 })
    expect(t.tws).toBeCloseTo(7, 9)
    expect(t.twd).toBeCloseTo(0, 6)
  })

  it('is a no-op with no current', () => {
    const t = groundToTrue({ gwd: 217, gws: 18.4, set: 90, drift: 0 })
    expect(t.twd).toBeCloseTo(217, 9)
    expect(t.tws).toBeCloseTo(18.4, 9)
  })

  it('round-trips groundToTrue -> trueToGround', () => {
    for (const gwd of [0, 37, 118, 205, 299, 359]) {
      for (const set of [12, 95, 190, 280]) {
        const t = groundToTrue({ gwd, gws: 14, set, drift: 2.5 })
        const g = trueToGround({ twd: t.twd, tws: t.tws, set, drift: 2.5 })
        expect(g.gws).toBeCloseTo(14, 9)
        // Compare directions with a wrapped difference, never with `-`.
        expect(((g.gwd - gwd + 540) % 360) - 180).toBeCloseTo(0, 6)
      }
    }
  })
})

describe('u/v components', () => {
  it('uses the meteorological sign convention', () => {
    // Wind FROM 090 is an easterly: it blows toward the west, so u < 0.
    const e = windToUV(90, 10)
    expect(e.u).toBeCloseTo(-10, 9)
    expect(e.v).toBeCloseTo(0, 9)
    // Wind FROM 000 is a northerly: it blows toward the south, so v < 0.
    const n = windToUV(0, 10)
    expect(n.u).toBeCloseTo(0, 9)
    expect(n.v).toBeCloseTo(-10, 9)
    // Wind FROM 225 (south-west) blows toward the north-east: u > 0, v > 0.
    const sw = windToUV(225, 10)
    expect(sw.u).toBeGreaterThan(0)
    expect(sw.v).toBeGreaterThan(0)
  })

  it('round-trips uvToWind', () => {
    for (const dir of [0, 45, 90, 179, 180, 270, 359.5]) {
      const uv = windToUV(dir, 12.3)
      const back = uvToWind(uv.u, uv.v)
      expect(back.speed).toBeCloseTo(12.3, 9)
      expect(back.dirFrom).toBeCloseTo(dir % 360, 6)
    }
  })

  it('does not invent a direction for a calm', () => {
    const calm = uvToWind(0, 0)
    expect(calm.speed).toBe(0)
    expect(calm.dirFrom).toBe(0)
  })
})
