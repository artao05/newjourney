/**
 * The synthetic boat.
 *
 * Its docstring says "this is not a toy": it drives the same `BoatState` the real
 * GPS produces, so every downstream calculation — start line, laylines, tactics,
 * routing — is exercised through it whenever anyone develops or demonstrates this
 * app off the water. It had no tests.
 *
 * The claim tested hardest here is reproducibility. "Deterministic pseudo-random so
 * a simulated race replays identically — essential when you are chasing a bug in
 * the tactical numbers" is a promise about debuggability, and a simulator that
 * quietly does something different on every run is worse than no simulator, because
 * the bug you were chasing moves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoatSim, makeStartLine, makeWLCourse } from './sim'
import { angsep, twaFrom } from './angles'
import { bearing, distance } from './geo'
import { buildLattice } from './polar'
import { findPolar } from '../data/polars'
import type { BoatState, LatLon } from './types'

const START: LatLon = { lat: 43.6675, lon: -70.1735 } // Hussey Sound, afloat

afterEach(() => {
  vi.useRealTimers()
})

/** Run `n` steps of `dtS` and return every state. */
function run(sim: BoatSim, n: number, dtS = 0.5): BoatState[] {
  const out: BoatState[] = []
  for (let i = 0; i < n; i++) out.push(sim.step(dtS))
  return out
}

const lattice = () => buildLattice(findPolar('j70')!.polar)

describe('reproducibility', () => {
  /*
   * The defect this file was written to find.
   *
   * The wind oscillation took its phase from `this.t`, which is seeded from
   * `Date.now()`. So the same seed replayed at a different wall-clock time produced
   * a different breeze and therefore a different race — exactly what the module
   * promises not to do. The phase now runs from elapsed time since construction, so
   * timestamps stay real while the weather repeats.
   */
  it('replays identically from the same seed, whatever the clock says', () => {
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'))
    const a = new BoatSim({ start: START, twd: 240, tws: 12 }, 7)
    a.setAutopilot({ mode: 'twa', twa: 45 })
    const first = run(a, 120)

    vi.setSystemTime(new Date('2026-08-20T03:47:11Z'))
    const b = new BoatSim({ start: START, twd: 240, tws: 12 }, 7)
    b.setAutopilot({ mode: 'twa', twa: 45 })
    const second = run(b, 120)

    for (let i = 0; i < first.length; i++) {
      expect(second[i].position.lat, `lat at step ${i}`).toBeCloseTo(first[i].position.lat, 12)
      expect(second[i].position.lon, `lon at step ${i}`).toBeCloseTo(first[i].position.lon, 12)
      expect(second[i].sog, `sog at step ${i}`).toBeCloseTo(first[i].sog, 12)
      expect(second[i].heading as number, `heading at step ${i}`).toBeCloseTo(
        first[i].heading as number,
        12,
      )
    }
  })

  it('still stamps real epoch times, not elapsed ones', () => {
    // The fix must not turn t into a relative clock: the start-line timer and the
    // tide lookups both need a real timestamp.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'))
    const sim = new BoatSim({ start: START, twd: 240, tws: 12 })
    const s = sim.step(1)
    expect(s.t).toBeGreaterThan(Date.UTC(2026, 7, 6, 11, 59))
    expect(s.t).toBeLessThan(Date.UTC(2026, 7, 6, 12, 1))
  })

  it('gives different races for different seeds', () => {
    // Determinism must not mean "identical regardless of seed", or the seed is
    // decoration and the oscillation is not exercising anything.
    const a = new BoatSim({ start: START, twd: 240, tws: 12 }, 1)
    const b = new BoatSim({ start: START, twd: 240, tws: 12 }, 2)
    a.setAutopilot({ mode: 'twa', twa: 45 })
    b.setAutopilot({ mode: 'twa', twa: 45 })
    const first = run(a, 200)
    const second = run(b, 200)
    const drift = Math.abs(first[199].position.lat - second[199].position.lat)
    expect(drift).toBeGreaterThan(0)
  })
})

describe('sailing the polar', () => {
  it('accelerates toward the polar speed for the sailed angle', () => {
    const lat = lattice()
    const sim = new BoatSim({ start: START, twd: 0, tws: 12, lattice: lat }, 3)
    sim.setAutopilot({ mode: 'twa', twa: 90 })
    const states = run(sim, 600) // 5 minutes
    const settled = states[states.length - 1]
    const target = lat.speed(sim.wind().tws, 90)
    // Within a knot of the polar: the sim has a first-order lag and the breeze
    // oscillates, so exactness would be the wrong assertion.
    expect(settled.bsp as number).toBeGreaterThan(target - 1)
    expect(settled.bsp as number).toBeLessThan(target + 1)
  })

  it('barely moves when pointed dead upwind', () => {
    const sim = new BoatSim({ start: START, twd: 0, tws: 12, lattice: lattice() }, 3)
    sim.setAutopilot({ mode: 'twa', twa: 0 })
    const states = run(sim, 400)
    expect(states[states.length - 1].bsp as number).toBeLessThan(1.5)
  })

  it('works with no polar at all, on the fallback shape', () => {
    const sim = new BoatSim({ start: START, twd: 0, tws: 12, fallbackSpeed: 6 }, 3)
    sim.setAutopilot({ mode: 'twa', twa: 90 })
    const states = run(sim, 600)
    const bsp = states[states.length - 1].bsp as number
    expect(bsp).toBeGreaterThan(1)
    expect(bsp).toBeLessThan(8)
  })

  it('tacks upwind toward a mark instead of pinching at it', () => {
    // What makes the sim useful for start and layline work: it will not sail into
    // the no-go zone, it picks a layline and changes tack.
    const lat = lattice()
    const mark = { lat: START.lat + 0.03, lon: START.lon } // ~1.8 nm dead upwind
    const sim = new BoatSim({ start: START, twd: 180, tws: 12, lattice: lat }, 5)
    sim.setAutopilot({ mode: 'mark', target: mark })

    const states = run(sim, 3000, 1) // 50 minutes
    const twas = states.map((s) => twaFrom(s.heading as number, 180))
    const sawPort = twas.some((t) => t < -20)
    const sawStarboard = twas.some((t) => t > 20)
    expect(sawPort && sawStarboard, 'sailed both tacks').toBe(true)

    // And it made ground toward the mark.
    const closed = distance(START, mark) - distance(states[states.length - 1].position, mark)
    expect(closed).toBeGreaterThan(0.2)
  })
})

describe('current and the water track', () => {
  it('drifts with the current alone in drift mode', () => {
    const sim = new BoatSim(
      { start: START, twd: 240, tws: 12, current: { set: 90, drift: 2, source: 'test' } },
      3,
    )
    // Default pilot is drift, so boat speed decays to nothing and only the water moves.
    const states = run(sim, 400)
    const last = states[states.length - 1]
    expect(last.bsp as number).toBeLessThan(0.2)
    expect(last.sog).toBeCloseTo(2, 1)
    expect(angsep(last.cog, 90)).toBeLessThan(5)
    // Eastward set moves longitude east, latitude barely at all.
    expect(last.position.lon).toBeGreaterThan(START.lon)
    expect(Math.abs(last.position.lat - START.lat)).toBeLessThan
      (0.001)
  })

  it('separates course over ground from heading when a current sets across', () => {
    const sim = new BoatSim(
      { start: START, twd: 180, tws: 12, current: { set: 90, drift: 2, source: 'test' }, lattice: lattice() },
      3,
    )
    sim.setAutopilot({ mode: 'heading', heading: 0 }) // steering due north
    const states = run(sim, 600)
    const last = states[states.length - 1]
    expect(angsep(last.heading as number, 0)).toBeLessThan(2)
    // Pushed east of the heading, and making more good over the ground than through
    // the water — the whole reason set and drift matter tactically.
    expect(last.cog).toBeGreaterThan(2)
    expect(last.cog).toBeLessThan(90)
    expect(last.sog).toBeGreaterThan(last.bsp as number)
  })

  it('moves in the direction it is actually going', () => {
    const sim = new BoatSim({ start: START, twd: 180, tws: 12, lattice: lattice() }, 3)
    sim.setAutopilot({ mode: 'heading', heading: 45 })
    const states = run(sim, 600)
    const travelled = bearing(START, states[states.length - 1].position)
    expect(angsep(travelled, states[states.length - 1].cog)).toBeLessThan
      (10)
  })
})

describe('robustness', () => {
  it('produces no NaN and stays bounded over a long run at a coarse step', () => {
    const sim = new BoatSim({ start: START, twd: 240, tws: 18, lattice: lattice() }, 9)
    sim.setAutopilot({ mode: 'twa', twa: 40 })
    for (const s of run(sim, 500, 30)) {
      expect(Number.isFinite(s.position.lat)).toBe(true)
      expect(Number.isFinite(s.position.lon)).toBe(true)
      expect(Number.isFinite(s.sog)).toBe(true)
      expect(s.sog).toBeGreaterThanOrEqual(0)
      expect(s.cog).toBeGreaterThanOrEqual(0)
      expect(s.cog).toBeLessThan(360)
      expect(Math.abs(s.heelDeg as number)).toBeLessThanOrEqual(32)
    }
  })

  it('keeps the wind oscillation inside its stated amplitude, plus the wander', () => {
    const sim = new BoatSim(
      { start: START, twd: 100, tws: 12, oscillationDeg: 8, oscillationPeriodS: 60 },
      4,
    )
    let worst = 0
    for (let i = 0; i < 2000; i++) {
      sim.step(0.5)
      worst = Math.max(worst, angsep(sim.wind().twd, 100))
    }
    // 8 degrees of oscillation plus a bounded +/-12 degree random walk.
    expect(worst).toBeGreaterThan(1)
    expect(worst).toBeLessThanOrEqual(21)
  })

  /**
   * The turn speed loss had an O(dtS²) step-size dependence: `turn` is the
   * angle actually turned (already proportional to dtS at full rate), and
   * `turnLoss * dtS * 0.5` multiplied by dtS again. At the app's 0.5 s step
   * the loss was barely noticeable; at dtS = 2 it was catastrophic; and as
   * dtS → 0 the loss vanished entirely — the opposite of convergent.
   *
   * This test runs the same 10-second manoeuvre at two step sizes and demands
   * that the final boat speed agrees within 25 %. With the dtS² bug the coarse
   * run lost far more speed (0.5 s retained ~92 %, 2.0 s retained ~40 %).
   */
  it('turn speed loss converges across step sizes', () => {
    // Build up speed first (60 steps × 0.5 s = 30 s on a beam reach), then
    // command a hard turn so the turn-loss path dominates.
    const mkSim = () => {
      const sim = new BoatSim(
        { start: START, twd: 0, tws: 12, lattice: lattice(), oscillationDeg: 0 },
        99,
      )
      sim.setAutopilot({ mode: 'heading', heading: 90 })
      run(sim, 60, 0.5) // build speed on a beam reach
      return sim
    }

    const a = mkSim()
    const b = mkSim()

    // Now command a heading that forces sustained full-rate turning.
    a.setAutopilot({ mode: 'heading', heading: 270 })
    b.setAutopilot({ mode: 'heading', heading: 270 })

    const fineStates = run(a, 20, 0.5) // 10 s at fine step
    const coarseStates = run(b, 5, 2.0) // 10 s at coarse step

    const speedFine = fineStates[fineStates.length - 1].bsp as number
    const speedCoarse = coarseStates[coarseStates.length - 1].bsp as number

    // Both should still have meaningful speed and agree within 25 %.
    expect(speedFine).toBeGreaterThan(1)
    expect(speedCoarse).toBeGreaterThan(1)
    const ratio = Math.min(speedFine, speedCoarse) / Math.max(speedFine, speedCoarse)
    expect(ratio).toBeGreaterThan(0.75)
  })

  /**
   * The noise random walk has the same class of dtS-scaling bug the turn loss
   * had: `(rng() - 0.5) * dtS * 0.35` makes the diffusion increment
   * proportional to dtS instead of sqrt(dtS). For an Ornstein-Uhlenbeck
   * process the equilibrium variance is σ²_step / (1 - α²); when σ²_step
   * scales with dtS² instead of dtS the equilibrium variance scales linearly
   * with dtS — i.e. the breeze wanders ten times harder at dtS = 5 than at
   * dtS = 0.5. The fix is `Math.sqrt(dtS)` instead of `dtS`.
   */
  it('wind noise variance does not depend on step size', () => {
    const base = 180
    const mkSim = () =>
      new BoatSim({ start: START, twd: base, tws: 12, oscillationDeg: 0 }, 42)

    function noiseVariance(dtS: number, steps: number): number {
      const sim = mkSim()
      sim.setAutopilot({ mode: 'heading', heading: base })
      let sumSq = 0
      let count = 0
      // Skip the first 500 s so the OU process reaches equilibrium.
      const warmup = Math.ceil(500 / dtS)
      for (let i = 0; i < warmup + steps; i++) {
        sim.step(dtS)
        if (i >= warmup) {
          const dev = sim.wind().twd - base
          // Normalise into [-180, 180) for safety, though noise is bounded ±12.
          const n = ((dev % 360) + 540) % 360 - 180
          sumSq += n * n
          count++
        }
      }
      return sumSq / count
    }

    const varFine = noiseVariance(0.5, 10_000) // 5 000 s of data
    const varCoarse = noiseVariance(5.0, 1_000) // 5 000 s of data

    // With correct sqrt(dtS) scaling the two should be close (ratio ≈ 1).
    // With the dtS bug the coarse variance is ~10× the fine.
    const r = Math.max(varFine, varCoarse) / Math.min(varFine, varCoarse)
    expect(r).toBeLessThan(3)
  })

  it('takes a new wind and sails to it', () => {
    const sim = new BoatSim({ start: START, twd: 0, tws: 12, lattice: lattice() }, 3)
    sim.setAutopilot({ mode: 'twa', twa: 90 })
    run(sim, 400)
    sim.setWind(180, 14)
    const after = run(sim, 800)
    const twa = twaFrom(after[after.length - 1].heading as number, 180)
    expect(Math.abs(twa)).toBeGreaterThan(60)
    expect(Math.abs(twa)).toBeLessThan(120)
  })
})

describe('makeStartLine', () => {
  it('builds a line of the requested length', () => {
    const line = makeStartLine(START, 240, 150)
    const m = distance(line.port, line.starboard) * 1852
    expect(m).toBeCloseTo(150, 0)
  })

  it('lays the line across the wind, offset by the bias', () => {
    // Square to a 240 wind is 330/150. With +6 of bias the line runs 336.
    const line = makeStartLine(START, 240, 200, 6)
    const brg = bearing(line.port, line.starboard)
    expect(angsep(brg, 336)).toBeLessThan(1)
  })

  it('puts the two ends on opposite sides of the centre', () => {
    const line = makeStartLine(START, 0, 300)
    const toPort = bearing(START, line.port)
    const toStarboard = bearing(START, line.starboard)
    expect(angsep(toPort, toStarboard)).toBeGreaterThan(179)
  })
})

describe('makeWLCourse', () => {
  it('places the marks up and down the axis at the requested distances', () => {
    const c = makeWLCourse(START, 30, 1.2, 0.4)
    expect(distance(START, c.windward)).toBeCloseTo(1.2, 3)
    expect(distance(START, c.leeward)).toBeCloseTo(0.4, 3)
    expect(angsep(bearing(START, c.windward), 30)).toBeLessThan(0.5)
    expect(angsep(bearing(START, c.leeward), 210)).toBeLessThan(0.5)
  })
})
