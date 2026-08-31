/**
 * Tests for the polar engine. See docs/03-algorithms/polars-and-vpp.md.
 *
 * The properties that matter most here are not "does it return a number" but
 *   - the interpolant never invents boat speed (anti-overshoot),
 *   - targets come off the interpolated curve, not the table knots,
 *   - the lattice the router actually uses agrees with the slow path.
 */

import { describe, expect, it } from 'vitest'
import { toRad } from './angles'
import type { BoatDims, BoatType } from './polar'
import {
  buildLattice,
  deriveTargets,
  generatePolar,
  heightScaleFactor,
  hullSpeedKn,
  parseCsvPolar,
  parseExpeditionPolar,
  parsePolar,
  polarSpeed,
  scaleTableToMasthead,
  serialiseExpeditionPolar,
  validatePolar,
} from './polar'
import type { PolarTable } from './types'
import { POLAR_LIBRARY, findPolar } from '../data/polars'

// A deliberately ragged sample: three rows, three different lengths, `!` comments,
// mixed tab and space separation — i.e. what a real Expedition file looks like.
const RAGGED = `
!Polar: Ragged Test Boat
! a comment line nobody parses
6\t45\t3.20\t60\t4.10\t90\t4.80\t120\t4.40\t150\t3.60\t180\t3.10
10 42 4.60 52 5.30 60 5.60 75 5.95 90 6.20 110 6.30 120 6.20 135 5.80 150 5.20 165 4.70 180 4.40
14\t40\t5.40\t90\t7.10\t135\t6.90\t180\t5.60
`

function errorsOf(p: PolarTable, dims?: Partial<BoatDims>): string[] {
  return validatePolar(p, dims)
    .filter((i) => i.severity === 'error')
    .map((i) => i.message)
}

describe('parsing and serialising', () => {
  it('reads ragged Expedition rows with their own lengths', () => {
    const p = parseExpeditionPolar(RAGGED)
    expect(p.name).toBe('Ragged Test Boat')
    expect(p.tws).toEqual([6, 10, 14])
    expect(p.rows.map((r) => r.twa.length)).toEqual([6, 11, 4])
    expect(p.rows[0].twa).toEqual([45, 60, 90, 120, 150, 180])
    expect(p.rows[2].bsp).toEqual([5.4, 7.1, 6.9, 5.6])
    expect(p.reference).toBe('10m')
  })

  it('round-trips parse -> serialise -> parse without drifting', () => {
    const p1 = parseExpeditionPolar(RAGGED)
    const s1 = serialiseExpeditionPolar(p1)
    const p2 = parseExpeditionPolar(s1)
    const s2 = serialiseExpeditionPolar(p2)
    expect(s2).toBe(s1)
    expect(p2).toEqual(p1)
    const p3 = parseExpeditionPolar(serialiseExpeditionPolar(p2))
    expect(serialiseExpeditionPolar(p3)).toBe(s1)
  })

  it('round-trips a generated polar including its name, source and reference', () => {
    const gen = generatePolar({ type: 'keelboat', loaM: 10.5, lwlM: 8.7 }, 'Round Trip')
    const masthead = scaleTableToMasthead(gen, 15)
    const back = parseExpeditionPolar(serialiseExpeditionPolar(masthead))
    expect(back.name).toBe('Round Trip')
    expect(back.reference).toBe('masthead')
    expect(back.source).toBe(masthead.source)
    expect(back.tws).toEqual(masthead.tws)
    expect(back.rows).toEqual(masthead.rows)
  })

  it('sorts, folds past 180 and de-duplicates on import', () => {
    const p = parseExpeditionPolar('8 180 4.0 90 6.0 270 5.5 90 6.4 45 3.0')
    // 270 folds to 90; the faster of the two 90s wins; angles come out sorted.
    expect(p.rows[0].twa).toEqual([45, 90, 180])
    expect(p.rows[0].bsp).toEqual([3, 6.4, 4])
  })

  it('reads a qtVlm-style CSV with TWA down the side', () => {
    const csv = [
      'twa\\tws;6;10;14',
      '0;0;0;0',
      '45;3.2;4.6;5.4',
      '90;4.8;6.2;7.1',
      '135;4.4;5.8;6.9',
      '180;3.1;4.4;5.6',
    ].join('\n')
    const p = parseCsvPolar(csv, 'qtVlm')
    expect(p.tws).toEqual([6, 10, 14])
    expect(p.rows[0].twa).toEqual([0, 45, 90, 135, 180])
    expect(p.rows[1].bsp).toEqual([0, 4.6, 6.2, 5.8, 4.4])
  })

  it('reads the transposed CSV layout too', () => {
    const csv = ['tws\\twa,0,45,90,135,180', '6,0,3.2,4.8,4.4,3.1', '12,0,5.0,6.6,6.1,4.8'].join('\n')
    const p = parseCsvPolar(csv)
    expect(p.tws).toEqual([6, 12])
    expect(p.rows[1].twa).toEqual([0, 45, 90, 135, 180])
    expect(p.rows[1].bsp).toEqual([0, 5, 6.6, 6.1, 4.8])
  })

  it('skips empty cells in CSV rather than treating them as zero', () => {
    // qtVlm layout: TWA down the side, empty cell at (TWA 90, TWS 10)
    const csv1 = [
      'twa\\tws;6;10;14',
      '45;3.2;4.6;5.4',
      '90;4.8;;7.1',
      '135;4.4;5.8;6.9',
      '180;3.1;4.4;5.6',
    ].join('\n')
    const p1 = parseCsvPolar(csv1, 'sparse')
    // The empty cell must not inject a spurious zero-speed entry.
    expect(p1.rows[1].twa).not.toContain(90)
    expect(p1.rows[1].bsp.every((v) => v > 0)).toBe(true)
    // The other rows are still complete.
    expect(p1.rows[0].twa).toContain(90)
    expect(p1.rows[2].twa).toContain(90)

    // Transposed layout: TWS down the side, empty cell at (TWS 10, TWA 90)
    const csv2 = [
      'tws\\twa,45,90,135,180',
      '6,3.2,4.8,4.4,3.1',
      '10,4.6,,5.8,4.4',
      '14,5.4,7.1,6.9,5.6',
    ].join('\n')
    const p2 = parseCsvPolar(csv2)
    expect(p2.rows[1].twa).not.toContain(90)
    expect(p2.rows[1].bsp.every((v) => v > 0)).toBe(true)
  })

  it('sniffs Expedition vs CSV', () => {
    const expedition = parsePolar(RAGGED)
    expect(expedition.tws).toEqual([6, 10, 14])
    const csv = parsePolar(['twa/tws;6;10', '45;3.2;4.6', '90;4.8;6.2', '180;3.1;4.4'].join('\n'))
    expect(csv.tws).toEqual([6, 10])
    // Header-less CSV: every field after the first is a speed, so the vote goes to CSV.
    const bare = parsePolar(['0;6;10', '45;3.2;4.6', '90;4.8;6.2', '180;3.1;4.4'].join('\n'))
    expect(bare.tws).toEqual([6, 10])
  })

  it('rejects input with no data', () => {
    expect(() => parsePolar('! just a comment\n\n')).toThrow()
    expect(() => parseExpeditionPolar('!nothing here')).toThrow()
  })
})

describe('ragged interpolation', () => {
  const p = parseExpeditionPolar(RAGGED)

  it('returns table values exactly at knots', () => {
    expect(polarSpeed(p, 6, 90)).toBeCloseTo(4.8, 10)
    expect(polarSpeed(p, 10, 110)).toBeCloseTo(6.3, 10)
    expect(polarSpeed(p, 14, 135)).toBeCloseTo(6.9, 10)
  })

  it('blends linearly between two rows of different lengths', () => {
    // TWA 90 exists in every row; TWS 8 is halfway between the 6 and 10 kn rows.
    expect(polarSpeed(p, 8, 90)).toBeCloseTo((4.8 + 6.2) / 2, 10)
    // TWA 120 is a knot in rows 0 and 1 but interpolated inside row 2.
    const at12 = polarSpeed(p, 12, 120)
    const lo = polarSpeed(p, 10, 120)
    const hi = polarSpeed(p, 14, 120)
    expect(at12).toBeCloseTo((lo + hi) / 2, 10)
    expect(at12).toBeGreaterThan(lo)
  })

  it('mirrors negative TWA and wraps beyond 180', () => {
    expect(polarSpeed(p, 10, -110)).toBeCloseTo(polarSpeed(p, 10, 110), 12)
    expect(polarSpeed(p, 10, 250)).toBeCloseTo(polarSpeed(p, 10, 110), 12)
  })

  it('is smooth: no jumps bigger than a knot per degree anywhere', () => {
    let prev = polarSpeed(p, 9.3, 0)
    for (let a = 0.25; a <= 180; a += 0.25) {
      const v = polarSpeed(p, 9.3, a)
      if (a > 45.5) expect(Math.abs(v - prev)).toBeLessThan(0.25)
      prev = v
    }
  })
})

describe('anti-overshoot (PCHIP, not a natural spline)', () => {
  // A row with a flat shoulder and a steep tail — the classic case where a natural
  // cubic spline bulges above the data and hands the router speed that does not exist.
  const spiky = parseExpeditionPolar(
    '10 0 0 30 1.0 60 6.0 90 6.1 120 6.0 150 3.0 180 1.0',
  )

  it('never leaves the interval spanned by its bracketing points', () => {
    const row = spiky.rows[0]
    for (let a = 0; a <= 180; a += 0.1) {
      const v = polarSpeed(spiky, 10, a)
      let k = 0
      while (k < row.twa.length - 2 && row.twa[k + 1] < a) k++
      const lo = Math.min(row.bsp[k], row.bsp[k + 1])
      const hi = Math.max(row.bsp[k], row.bsp[k + 1])
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9)
      expect(v).toBeLessThanOrEqual(hi + 1e-9)
    }
  })

  it('never exceeds the global maximum of the table', () => {
    const max = Math.max(...spiky.rows[0].bsp)
    for (let a = 0; a <= 180; a += 0.1) {
      expect(polarSpeed(spiky, 10, a)).toBeLessThanOrEqual(max + 1e-9)
    }
  })

  it('stays monotone across a monotone stretch', () => {
    let prev = -Infinity
    for (let a = 0; a <= 60; a += 0.1) {
      const v = polarSpeed(spiky, 10, a)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
  })

  it('reproduces linear data exactly', () => {
    const pairs: string[] = []
    for (let a = 0; a <= 180; a += 20) pairs.push(`${a} ${a / 30}`)
    const line = parseExpeditionPolar(`10 ${pairs.join(' ')}`)
    for (let a = 0; a <= 180; a += 0.7) {
      expect(polarSpeed(line, 10, a)).toBeCloseTo(a / 30, 9)
    }
  })
})

describe('deriveTargets', () => {
  // bsp(twa) = V sin(twa)  =>  VMG = V sin(twa) cos(twa) = (V/2) sin(2 twa),
  // maximised at exactly 45 deg and minimised at exactly 135 deg, with |VMG| = V/2.
  const V = 8
  const circleRow = (): string => {
    const pairs: string[] = []
    for (let a = 0; a <= 180; a += 1) pairs.push(`${a} ${(V * Math.sin(toRad(a))).toFixed(6)}`)
    return pairs.join(' ')
  }
  const circle = parseExpeditionPolar(`10 ${circleRow()}\n20 ${circleRow()}`)

  it('finds the analytic VMG optimum on a synthetic polar', () => {
    const t = deriveTargets(circle, 10)
    expect(t.upTwa).toBeCloseTo(45, 1)
    expect(t.downTwa).toBeCloseTo(135, 1)
    expect(t.upBsp).toBeCloseTo(V * Math.SQRT1_2, 3)
    expect(t.upVmg).toBeCloseTo(V / 2, 3)
    expect(t.downVmg).toBeCloseTo(-V / 2, 3)
    expect(t.tws).toBe(10)
  })

  it('beats the best table knot — it searches the interpolated curve', () => {
    // Knots at 40 and 52 straddle the true 45 deg optimum of the circle polar.
    const coarse = parseExpeditionPolar(
      `10 0 0 40 ${(V * Math.sin(toRad(40))).toFixed(4)} 52 ${(V * Math.sin(toRad(52))).toFixed(4)}` +
        ` 90 ${V} 130 ${(V * Math.sin(toRad(130))).toFixed(4)} 140 ${(V * Math.sin(toRad(140))).toFixed(4)} 180 0`,
    )
    const t = deriveTargets(coarse, 10)
    const knotBest = Math.max(
      ...coarse.rows[0].twa.map((a, i) => coarse.rows[0].bsp[i] * Math.cos(toRad(a))),
    )
    expect(t.upVmg).toBeGreaterThan(knotBest)
    expect(t.upTwa).toBeGreaterThan(40)
    expect(t.upTwa).toBeLessThan(52)
  })

  it('keeps targets inside their half of the circle', () => {
    const t = deriveTargets(circle, 15)
    expect(t.upTwa).toBeGreaterThan(0)
    expect(t.upTwa).toBeLessThanOrEqual(90)
    expect(t.downTwa).toBeGreaterThanOrEqual(90)
    expect(t.downTwa).toBeLessThan(180)
    expect(t.upVmg).toBeGreaterThan(0)
    expect(t.downVmg).toBeLessThan(0)
  })

  it('reports zero speed and neutral angles in no wind', () => {
    const t = deriveTargets(circle, 0)
    expect(t.upBsp).toBe(0)
    expect(t.downBsp).toBe(0)
    expect(t.upVmg).toBe(0)
    expect(t.upTwa).toBeGreaterThan(0)
    expect(t.downTwa).toBeGreaterThan(90)
  })
})

describe('range behaviour', () => {
  const p = parseExpeditionPolar(RAGGED)

  it('scales linearly toward zero below the lowest row', () => {
    const at6 = polarSpeed(p, 6, 90)
    expect(polarSpeed(p, 3, 90)).toBeCloseTo(at6 / 2, 10)
    expect(polarSpeed(p, 1.5, 90)).toBeCloseTo(at6 / 4, 10)
    expect(polarSpeed(p, 0, 90)).toBe(0)
    expect(polarSpeed(p, -5, 90)).toBe(0)
  })

  it('holds the top row above the table and never extrapolates upward', () => {
    const at14 = polarSpeed(p, 14, 120)
    expect(polarSpeed(p, 25, 120)).toBe(at14)
    expect(polarSpeed(p, 60, 120)).toBe(at14)
    expect(polarSpeed(p, 999, 120)).toBe(at14)
  })

  it('ramps continuously to zero through the no-go zone', () => {
    // Row 0 starts at TWA 45; below that the table makes no claim, so the speed ramps
    // linearly to zero at TWA 0 rather than stepping off a cliff the lattice cannot hold.
    expect(polarSpeed(p, 6, 45)).toBeCloseTo(3.2, 10)
    expect(polarSpeed(p, 6, 22.5)).toBeCloseTo(1.6, 10)
    expect(polarSpeed(p, 6, 0)).toBe(0)
    expect(polarSpeed(p, 6, 44.999)).toBeLessThan(3.2)
    expect(polarSpeed(p, 6, 44.999)).toBeGreaterThan(3.19)
  })

  it('never reports a target at an angle the table has no data for', () => {
    // A table that starts at 80 deg cannot point, and must not claim it can just because
    // the no-go ramp happens to peak in VMG near 49 deg.
    const wide = parseExpeditionPolar('10 80 6.0 90 6.4 135 6.0 180 4.0')
    expect(deriveTargets(wide, 10).upTwa).toBeGreaterThanOrEqual(80)
    // Likewise a table stopping short of 180 must not target 179.5 by extrapolation.
    const short = parseExpeditionPolar('10 40 5.0 90 7.0 155 6.0')
    expect(deriveTargets(short, 10).downTwa).toBeLessThanOrEqual(155)
  })

  it('holds the last breakpoint above it', () => {
    const last = parseExpeditionPolar('10 40 5.0 90 7.0 160 6.0')
    expect(polarSpeed(last, 10, 170)).toBe(6)
    expect(polarSpeed(last, 10, 180)).toBe(6)
  })

  it('handles a degenerate one-row, one-point table', () => {
    const tiny = parseExpeditionPolar('10 90 5.0')
    expect(polarSpeed(tiny, 10, 90)).toBe(5)
    expect(polarSpeed(tiny, 10, 120)).toBe(5)
    expect(polarSpeed(tiny, 5, 90)).toBeCloseTo(2.5, 10)
  })
})

describe('wind height scaling', () => {
  it('matches the worked example from the Expedition manual', () => {
    // 20 m rig, a = 0.12 -> (20/10)^0.12 = 1.09, i.e. "enter 109%".
    expect(heightScaleFactor(20)).toBeCloseTo(1.09, 2)
    expect(heightScaleFactor(20, 0.12)).toBeCloseTo(1.09, 2)
    expect(heightScaleFactor(10)).toBeCloseTo(1, 12)
    expect(heightScaleFactor(5)).toBeLessThan(1)
    expect(heightScaleFactor(20, 0.14)).toBeGreaterThan(heightScaleFactor(20, 0.11))
  })

  it('is a no-op for nonsense heights', () => {
    expect(heightScaleFactor(0)).toBe(1)
    expect(heightScaleFactor(-3)).toBe(1)
    expect(heightScaleFactor(NaN)).toBe(1)
  })

  it('moves the TWS axis, not the boat speeds', () => {
    const p = parseExpeditionPolar(RAGGED)
    const m = scaleTableToMasthead(p, 20)
    expect(m.reference).toBe('masthead')
    expect(m.rows).toEqual(p.rows)
    expect(m.tws[0]).toBeCloseTo(6 * heightScaleFactor(20), 3)
    expect(p.reference).toBe('10m')
    expect(p.tws[0]).toBe(6)
  })

  it('will not scale a masthead table twice', () => {
    const p = parseExpeditionPolar(RAGGED)
    const once = scaleTableToMasthead(p, 20)
    const twice = scaleTableToMasthead(once, 20)
    expect(twice.tws).toEqual(once.tws)
  })
})

describe('lattice', () => {
  const p = parseExpeditionPolar(RAGGED)
  const lat = buildLattice(p)

  it('has the documented shape', () => {
    expect(lat.twsCount).toBe(101)
    expect(lat.twaCount).toBe(181)
    expect(lat.grid.length).toBe(101 * 181)
    expect(lat.grid).toBeInstanceOf(Float32Array)
    expect(lat.targets.length).toBe(101)
    expect(lat.twsMax).toBe(50)
  })

  it('is exact at lattice nodes', () => {
    for (let tws = 0; tws <= 50; tws += 0.5) {
      for (let twa = 0; twa <= 180; twa += 10) {
        expect(lat.speed(tws, twa)).toBeCloseTo(polarSpeed(p, tws, twa), 5)
      }
    }
  })

  it('agrees with the direct lookup off-node', () => {
    let worst = 0
    for (let tws = 0.13; tws <= 32; tws += 0.37) {
      for (let twa = 0.7; twa <= 180; twa += 0.83) {
        const d = Math.abs(lat.speed(tws, twa) - polarSpeed(p, tws, twa))
        if (d > worst) worst = d
      }
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('mirrors and clamps the same way the direct lookup does', () => {
    expect(lat.speed(10, -110)).toBeCloseTo(lat.speed(10, 110), 6)
    expect(lat.speed(80, 120)).toBeCloseTo(lat.speed(50, 120), 6)
    expect(lat.speed(-1, 120)).toBe(0)
    expect(lat.speed(10, 300)).toBeCloseTo(lat.speed(10, 180), 6)
  })

  it('serves precomputed targets', () => {
    const t = lat.targetsAt(12)
    expect(t.tws).toBe(12)
    expect(t).toBe(lat.targets[24])
    expect(t.upTwa).toBeCloseTo(deriveTargets(p, 12).upTwa, 6)
    expect(lat.targetsAt(-4)).toBe(lat.targets[0])
    expect(lat.targetsAt(500)).toBe(lat.targets[100])
    // 12.2 kn rounds to the 12.0 kn lattice line.
    expect(lat.targetsAt(12.2)).toBe(t)
  })

  it('honours custom resolutions', () => {
    const coarse = buildLattice(p, { twsMax: 30, twsStep: 1, twaStep: 2 })
    expect(coarse.twsCount).toBe(31)
    expect(coarse.twaCount).toBe(91)
    expect(coarse.twsMax).toBe(30)
    expect(coarse.speed(10, 90)).toBeCloseTo(polarSpeed(p, 10, 90), 5)
  })

  it('allocates nothing in the hot path', () => {
    // A weak proxy: a million lookups must not blow up, and must be deterministic.
    let acc = 0
    for (let i = 0; i < 200000; i++) acc += lat.speed((i % 400) * 0.1, (i % 360) - 180)
    expect(Number.isFinite(acc)).toBe(true)
    expect(lat.speed(11.3, 47.6)).toBe(lat.speed(11.3, 47.6))
  })
})

describe('generatePolar', () => {
  const TYPES: BoatType[] = ['dinghy', 'sportboat', 'keelboat', 'cruiser', 'multihull']
  const SAMPLES: Record<BoatType, BoatDims> = {
    dinghy: { type: 'dinghy', loaM: 4.23, lwlM: 3.81, dispKg: 139, sailAreaM2: 7.06 },
    sportboat: { type: 'sportboat', loaM: 6.93, lwlM: 5.79, dispKg: 794, sailAreaM2: 21.9 },
    keelboat: { type: 'keelboat', loaM: 10.52, lwlM: 8.66, dispKg: 3357, sailAreaM2: 51.2 },
    cruiser: { type: 'cruiser', loaM: 12.2, lwlM: 10.6, dispKg: 8200, sailAreaM2: 78 },
    multihull: { type: 'multihull', loaM: 5.25, lwlM: 5.25, dispKg: 317, sailAreaM2: 18.5 },
  }

  it('validates clean for every boat type', () => {
    for (const type of TYPES) {
      const dims = SAMPLES[type]
      expect(errorsOf(generatePolar(dims), dims), type).toEqual([])
    }
  })

  it('validates clean with dimensions alone', () => {
    for (const type of TYPES) {
      const dims: BoatDims = { type, loaM: SAMPLES[type].loaM }
      expect(errorsOf(generatePolar(dims), dims), type).toEqual([])
    }
  })

  it('raises no warnings either for the sample fleet', () => {
    for (const type of TYPES) {
      const dims = SAMPLES[type]
      expect(validatePolar(generatePolar(dims), dims), type).toEqual([])
    }
  })

  it('puts targets where a sailor would expect them', () => {
    for (const type of TYPES) {
      const p = generatePolar(SAMPLES[type])
      for (const tws of [6, 10, 16, 20]) {
        const t = deriveTargets(p, tws)
        expect(t.upTwa, `${type} up @${tws}`).toBeGreaterThan(33)
        expect(t.upTwa, `${type} up @${tws}`).toBeLessThan(60)
        expect(t.downTwa, `${type} down @${tws}`).toBeGreaterThan(110)
        expect(t.downTwa, `${type} down @${tws}`).toBeLessThan(180)
        expect(t.upBsp).toBeGreaterThan(0)
        expect(t.upVmg).toBeGreaterThan(0)
        expect(t.downVmg).toBeLessThan(0)
      }
    }
  })

  it('stays under the hull-speed-derived ceiling and above zero', () => {
    for (const type of TYPES) {
      const dims = SAMPLES[type]
      const p = generatePolar(dims)
      const ceiling = hullSpeedKn(dims.lwlM as number) * 4
      for (const row of p.rows) {
        for (const v of row.bsp) {
          expect(v).toBeGreaterThan(0)
          expect(v).toBeLessThan(ceiling)
        }
      }
    }
  })

  it('is monotone in TWS at every angle', () => {
    // Tolerance is the 0.01 kn quantisation of the stored table: PCHIP tangents shift by
    // a rounding step between adjacent rows near saturation. Well below the 0.05 kn
    // threshold at which validatePolar starts calling it de-powering.
    for (const type of TYPES) {
      const p = generatePolar(SAMPLES[type])
      for (let a = 35; a <= 180; a += 5) {
        let prev = -Infinity
        for (const tws of p.tws) {
          const v = polarSpeed(p, tws, a)
          expect(v, `${type} @${a}`).toBeGreaterThanOrEqual(prev - 0.01)
          prev = v
        }
      }
    }
  })

  it('makes a bigger boat faster and a lighter boat quicker in the light', () => {
    const small = generatePolar({ type: 'keelboat', loaM: 9 })
    const big = generatePolar({ type: 'keelboat', loaM: 14 })
    expect(polarSpeed(big, 12, 90)).toBeGreaterThan(polarSpeed(small, 12, 90))
    const heavy = generatePolar({ type: 'keelboat', loaM: 11, dispKg: 8000, sailAreaM2: 60 })
    const light = generatePolar({ type: 'keelboat', loaM: 11, dispKg: 4000, sailAreaM2: 60 })
    expect(polarSpeed(light, 5, 90)).toBeGreaterThan(polarSpeed(heavy, 5, 90))
  })

  it('rejects a nonsense boat', () => {
    expect(() => generatePolar({ type: 'keelboat', loaM: 0 })).toThrow()
    expect(() => generatePolar({ type: 'keelboat', loaM: NaN })).toThrow()
  })

  it('serialises to something Expedition could read', () => {
    const text = serialiseExpeditionPolar(generatePolar(SAMPLES.keelboat, 'Gen'))
    const back = parsePolar(text)
    expect(back.name).toBe('Gen')
    expect(back.tws).toEqual([4, 6, 8, 10, 12, 14, 16, 20, 25, 30])
  })
})

describe('validatePolar', () => {
  it('accepts a sane table', () => {
    expect(validatePolar(parseExpeditionPolar(RAGGED))).toEqual([])
  })

  it('rejects boat speed in zero wind', () => {
    const p = parseExpeditionPolar('0 45 1.0 90 2.0 180 1.0\n10 45 4.0 90 6.0 180 4.0')
    expect(errorsOf(p).join(' ')).toMatch(/zero wind/)
  })

  it('accepts a zero row at zero wind', () => {
    const p = parseExpeditionPolar('0 45 0 90 0 180 0\n10 45 4.0 90 6.0 180 4.0')
    expect(errorsOf(p)).toEqual([])
  })

  it('rejects speeds through the hull-speed ceiling', () => {
    const p = parseExpeditionPolar('10 45 6.0 90 24.0 180 6.0')
    const dims: Partial<BoatDims> = { type: 'keelboat', loaM: 10, lwlM: 8.5 }
    expect(errorsOf(p, dims).join(' ')).toMatch(/ceiling/)
    expect(errorsOf(p, { type: 'multihull', loaM: 10, lwlM: 8.5 })).toEqual([])
  })

  it('rejects structural damage', () => {
    const broken: PolarTable = {
      name: 'broken',
      tws: [10, 8],
      rows: [
        { twa: [90, 45], bsp: [6, 4] },
        { twa: [45, 90], bsp: [4] },
      ],
      reference: '10m',
    }
    const messages = errorsOf(broken).join(' ')
    expect(messages).toMatch(/strictly increase/)
    expect(messages).toMatch(/angles but/)
    expect(validatePolar({ name: 'x', tws: [], rows: [], reference: '10m' })).toHaveLength(1)
  })

  it('warns but does not reject when the boat de-powers', () => {
    const p = parseExpeditionPolar('10 45 5.0 90 7.0 180 5.0\n30 45 3.0 90 5.0 180 4.0')
    const issues = validatePolar(p)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(issues.some((i) => i.message.includes('de-powers'))).toBe(true)
  })

  it('warns about a pronounced dent', () => {
    const p = parseExpeditionPolar('10 45 5.0 60 6.0 75 3.5 90 7.0 135 6.5 180 5.0')
    expect(validatePolar(p).some((i) => i.message.includes('dent'))).toBe(true)
  })

  it('warns about an implausible target angle', () => {
    // A table that only starts at 80 deg cannot possibly point.
    const p = parseExpeditionPolar('10 80 6.0 90 6.4 135 6.0 180 4.0')
    const messages = validatePolar(p, { type: 'keelboat', loaM: 10 })
      .map((i) => i.message)
      .join(' ')
    expect(messages).toMatch(/upwind target/)
  })
})

describe('built-in polar library', () => {
  it('ships a fleet spanning dinghy to cruiser', () => {
    expect(POLAR_LIBRARY.length).toBeGreaterThanOrEqual(10)
    const types = new Set(POLAR_LIBRARY.map((e) => e.type))
    expect(types).toEqual(new Set(['dinghy', 'sportboat', 'keelboat', 'cruiser', 'multihull']))
    expect(new Set(POLAR_LIBRARY.map((e) => e.id)).size).toBe(POLAR_LIBRARY.length)
  })

  it('validates every entry with no errors', () => {
    for (const e of POLAR_LIBRARY) {
      expect(errorsOf(e.polar, { type: e.type, loaM: e.loaM }), e.id).toEqual([])
    }
  })

  it('labels every entry as generated rather than measured', () => {
    for (const e of POLAR_LIBRARY) {
      expect(e.polar.source, e.id).toMatch(/[Gg]enerated/)
      expect(e.polar.reference).toBe('10m')
    }
  })

  it('is ordered by plausible speed: an Optimist is slower than a J/105', () => {
    const opti = findPolar('optimist')
    const j105 = findPolar('j105')
    const nacra = findPolar('nacra17')
    expect(opti).toBeDefined()
    expect(j105).toBeDefined()
    expect(nacra).toBeDefined()
    const at = (e: typeof opti, twa: number) => polarSpeed((e as PolarLookup).polar, 12, twa)
    expect(at(opti, 90)).toBeLessThan(at(j105, 90))
    expect(at(j105, 90)).toBeLessThan(at(nacra, 90))
    // A cat gives away its downwind angle to keep the apparent wind on.
    const nacraT = deriveTargets((nacra as PolarLookup).polar, 12)
    const j105T = deriveTargets((j105 as PolarLookup).polar, 12)
    expect(nacraT.downTwa).toBeLessThan(j105T.downTwa)
  })

  it('returns undefined for an unknown id', () => {
    expect(findPolar('nope')).toBeUndefined()
  })
})

type PolarLookup = { polar: PolarTable }
