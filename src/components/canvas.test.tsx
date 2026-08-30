/**
 * The canvas renderers, tested through a recording 2D context.
 *
 * Four components draw with `getContext('2d')` — `StartCanvas` (387 lines, the
 * beachhead display), `PolarPlot`, `CurrentChart` and `DepartureChart` — and none
 * had a single test. They are hard to assert on in the usual way because their
 * output is pixels, so this substitutes a fake context and asserts on the *calls*.
 *
 * The invariant that justifies the whole file:
 *
 *   **A NaN coordinate silently draws nothing.**
 *
 * `moveTo(NaN, 10)` does not throw, does not warn, and leaves the canvas exactly as
 * it was. So a NaN reaching a drawing call is invisible in a browser — the line you
 * expected simply is not there, and there is nothing in the console to explain it.
 * That makes it the one bug class in this part of the codebase that testing can find
 * and eyeballing cannot. Every case below drives the component with degenerate
 * inputs and asserts that no non-finite number ever reaches the context.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { StartCanvas } from './StartCanvas'
import { PolarPlot } from './PolarPlot'
import { CurrentChart } from './CurrentChart'
import { DepartureChart } from './DepartureChart'
import { findPolar } from '@/data/polars'
import { computeStart } from '@/lib/startline'
import { buildLattice } from '@/lib/polar'
import type {
  Boat,
  BoatState,
  StartLine,
  StartNumbers,
  TrackPoint,
  WindEstimate,
} from '@/lib/types'

// ------------------------------------------------------- recording 2d context

interface Call {
  op: string
  args: unknown[]
}

class RecordingContext {
  calls: Call[] = []
  // Properties the components set; recorded so colour choices can be asserted.
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 0
  font = ''
  textAlign = ''
  globalAlpha = 1
  readonly styles: string[] = []

  private rec(op: string, args: unknown[]) {
    this.calls.push({ op, args })
  }

  setTransform(...a: unknown[]) {
    this.rec('setTransform', a)
  }
  save() {
    this.rec('save', [])
  }
  restore() {
    this.rec('restore', [])
  }
  translate(...a: unknown[]) {
    this.rec('translate', a)
  }
  rotate(...a: unknown[]) {
    this.rec('rotate', a)
  }
  beginPath() {
    this.rec('beginPath', [])
  }
  closePath() {
    this.rec('closePath', [])
  }
  moveTo(...a: unknown[]) {
    this.rec('moveTo', a)
  }
  lineTo(...a: unknown[]) {
    this.rec('lineTo', a)
  }
  quadraticCurveTo(...a: unknown[]) {
    this.rec('quadraticCurveTo', a)
  }
  arc(...a: unknown[]) {
    // A browser throws IndexSizeError on a negative radius, and that is exactly
    // how the zero-width-parent crash took out the Setup screen. Reproduce it, or
    // the guards protecting against it cannot be tested.
    const r = a[2]
    if (typeof r === 'number' && r < 0) {
      throw new DOMException('The radius provided is negative', 'IndexSizeError')
    }
    this.rec('arc', a)
  }
  fill() {
    this.rec('fill', [])
    this.styles.push(String(this.fillStyle))
  }
  stroke() {
    this.rec('stroke', [])
    this.styles.push(String(this.strokeStyle))
  }
  fillRect(...a: unknown[]) {
    this.rec('fillRect', a)
    this.styles.push(String(this.fillStyle))
  }
  fillText(...a: unknown[]) {
    this.rec('fillText', a)
  }
  setLineDash(...a: unknown[]) {
    this.rec('setLineDash', a)
  }
  clearRect(...a: unknown[]) {
    this.rec('clearRect', a)
  }
  strokeRect(...a: unknown[]) {
    this.rec('strokeRect', a)
    this.styles.push(String(this.strokeStyle))
  }
  rect(...a: unknown[]) {
    this.rec('rect', a)
  }
  clip() {
    this.rec('clip', [])
  }
}

let ctx: RecordingContext

/** Every numeric argument that reached the context, with the call that carried it. */
function numericArgs(c: RecordingContext): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  for (const call of c.calls) {
    call.args.forEach((a, i) => {
      if (typeof a === 'number') out.push([call.op, i, a])
      else if (Array.isArray(a)) {
        a.forEach((x, j) => {
          if (typeof x === 'number') out.push([`${call.op}[${j}]`, i, x])
        })
      }
    })
  }
  return out
}

/**
 * The assertion this file exists for. Also excludes the text calls: `fillText`
 * carries a string that would render the word "NaN" on the chart, which is the
 * same defect wearing different clothes.
 */
function expectNothingUndrawable(c: RecordingContext, label: string): void {
  for (const [op, i, n] of numericArgs(c)) {
    expect(Number.isFinite(n), `${label}: ${op} arg ${i} is ${n}`).toBe(true)
  }
  for (const call of c.calls) {
    if (call.op !== 'fillText') continue
    expect(String(call.args[0]), `${label}: fillText`).not.toMatch(/NaN|Infinity|undefined/)
  }
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  ctx = new RecordingContext()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
  // jsdom returns null from getContext; hand back the recorder instead, and give
  // the parent a non-zero size so the components have something to lay out in.
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 380, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 620, configurable: true })
})

afterEach(() => {
  cleanup()
})

// ------------------------------------------------------------------ fixtures

const BOAT: Boat = {
  id: 'me',
  name: 'test',
  className: 'J/70',
  loaMetres: 6.93,
  bowToGpsMetres: 3,
  mastHeightMetres: 11,
  polarPct: 100,
  polarPctNight: 96,
  tackPenaltyS: 12,
  gybePenaltyS: 8,
}

const NOW = Date.UTC(2026, 7, 27, 14, 0, 0)
const MID = { lat: 43.6675, lon: -70.1735 }

const LINE: StartLine = {
  port: { lat: MID.lat, lon: MID.lon - 0.0012 },
  starboard: { lat: MID.lat, lon: MID.lon + 0.0012 },
  gunTime: NOW + 120_000,
}

function stateOf(over: Partial<BoatState> = {}): BoatState {
  return {
    t: NOW,
    position: { lat: MID.lat - 0.0008, lon: MID.lon },
    cog: 350,
    sog: 4.6,
    accuracyM: 4,
    heading: 352,
    bsp: 4.5,
    heelDeg: 8,
    ...over,
  }
}

const WIND: WindEstimate = {
  twd: 0,
  tws: 11,
  source: 'manual',
  uncertaintyDeg: 8,
  t: NOW,
}

const lattice = buildLattice(findPolar('j70')!.polar)

function numbersFor(line: StartLine, state: BoatState | null, wind: WindEstimate | null): StartNumbers {
  return computeStart({
    line,
    state: state ?? stateOf(),
    wind,
    boat: BOAT,
    lattice,
    now: NOW,
  })
}

function track(n: number): TrackPoint[] {
  const out: TrackPoint[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      t: NOW - (n - i) * 1000,
      lat: MID.lat - 0.002 + i * 0.00002,
      lon: MID.lon - 0.0005 + i * 0.00001,
      sog: 4 + (i % 5) * 0.1,
      cog: 350,
    })
  }
  return out
}

// ---------------------------------------------------------------- StartCanvas

describe('StartCanvas', () => {
  it('draws something at all', () => {
    render(
      <StartCanvas
        line={LINE}
        state={stateOf()}
        wind={WIND}
        numbers={numbersFor(LINE, stateOf(), WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expect(ctx.calls.length).toBeGreaterThan(10)
    expect(ctx.calls.some((c) => c.op === 'stroke' || c.op === 'fill')).toBe(true)
  })

  it('passes nothing undrawable to the context, across every degenerate input', () => {
    /*
     * The heart of the file. Each of these is a state the app really reaches: no
     * fix yet, no wind yet, one end pinged, neither end pinged, a line pinged twice
     * in the same spot, and the gun already fired.
     */
    const cases: Array<[string, StartLine, BoatState | null, WindEstimate | null, number | null]> = [
      ['everything present', LINE, stateOf(), WIND, null],
      ['no fix', LINE, null, WIND, null],
      ['no wind', LINE, stateOf(), null, null],
      ['no fix and no wind', LINE, null, null, null],
      ['only the pin pinged', { ...LINE, starboard: null }, stateOf(), WIND, null],
      ['only the boat pinged', { ...LINE, port: null }, stateOf(), WIND, null],
      ['neither end pinged', { port: null, starboard: null, gunTime: LINE.gunTime }, stateOf(), WIND, null],
      ['no gun time', { ...LINE, gunTime: null }, stateOf(), WIND, null],
      // A real fix that carries no course: the GPS reports position but reports
      // `speed` and `heading` as null, which it does whenever the boat is not
      // moving. `useSensors` puts NaN in the state rather than a fabricated due
      // north, so every canvas has to cope with a NaN bearing on a valid fix.
      ['a fix with no course', LINE, stateOf({ cog: NaN, sog: NaN, heading: null }), WIND, null],
      ['a fix with no course but a compass', LINE, stateOf({ cog: NaN, sog: NaN }), WIND, null],
      [
        'degenerate line, both ends the same point',
        { port: { ...MID }, starboard: { ...MID }, gunTime: LINE.gunTime },
        stateOf(),
        WIND,
        null,
      ],
      ['after the gun', LINE, stateOf(), WIND, 45],
      ['long after the gun', LINE, stateOf(), WIND, 600],
      ['stationary boat', LINE, stateOf({ sog: 0, bsp: 0 }), WIND, null],
      ['no compass', LINE, stateOf({ heading: null }), WIND, null],
      ['no accuracy figure', LINE, stateOf({ accuracyM: null }), WIND, null],
      ['over the line early', LINE, stateOf({ position: { lat: MID.lat + 0.0006, lon: MID.lon } }), WIND, null],
      ['miles from the line', LINE, stateOf({ position: { lat: MID.lat + 0.4, lon: MID.lon + 0.4 } }), WIND, null],
    ]

    for (const [label, line, state, wind, since] of cases) {
      ctx = new RecordingContext()
      const view = render(
        <StartCanvas
          line={line}
          state={state}
          wind={wind}
          numbers={numbersFor(line, state, wind)}
          boat={BOAT}
          track={[]}
          secondsSinceGun={since}
        />,
      )
      expectNothingUndrawable(ctx, label)
      view.unmount()
      cleanup()
    }
  })

  it('stays drawable with a track, including a single point and a long one', () => {
    for (const n of [0, 1, 2, 500]) {
      ctx = new RecordingContext()
      const view = render(
        <StartCanvas
          line={LINE}
          state={stateOf()}
          wind={WIND}
          numbers={numbersFor(LINE, stateOf(), WIND)}
          boat={BOAT}
          track={track(n)}
          secondsSinceGun={null}
        />,
      )
      expectNothingUndrawable(ctx, `track of ${n}`)
      view.unmount()
      cleanup()
    }
  })

  it('survives a collapsed extent, where the scale divides by zero', () => {
    /*
     * `scale` is min(w / (maxX - minX), h / (maxY - minY)). If everything the
     * canvas has to show sits on one point, both extents are zero and the scale is
     * a division by zero - Infinity, or NaN when the canvas has no size either.
     * Every coordinate downstream is then non-finite, and a non-finite coordinate
     * draws nothing at all without raising anything.
     *
     * Reached by pinging both ends in the same place - a double tap without moving
     * - and then losing the fix.
     */
    const samePoint: StartLine = { port: { ...MID }, starboard: { ...MID }, gunTime: null }
    ctx = new RecordingContext()
    const view = render(
      <StartCanvas
        line={samePoint}
        state={null}
        wind={null}
        numbers={numbersFor(samePoint, null, null)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expectNothingUndrawable(ctx, 'collapsed extent')
    view.unmount()
    cleanup()
  })

  it('draws nothing rather than garbage when its parent has no size', () => {
    // The guard PolarPlot, CurrentChart and DepartureChart all carry and this one
    // did not. A zero-size parent happens whenever the pane has not been laid out
    // at first paint: a collapsed container, a display:none ancestor, a zero-size
    // viewport.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 0, configurable: true })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 0, configurable: true })
    ctx = new RecordingContext()
    const view = render(
      <StartCanvas
        line={LINE}
        state={stateOf()}
        wind={WIND}
        numbers={numbersFor(LINE, stateOf(), WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expectNothingUndrawable(ctx, 'zero-size parent')
    // With the guard in place it declines to draw at all, rather than drawing a
    // picture collapsed onto a single point.
    expect(ctx.calls.length).toBe(0)
    view.unmount()
    cleanup()
  })

  it('draws the boat without a bow when there is no heading to point', () => {
    /*
     * A stationary GPS reports no course, so the bearing the hull is rotated by is
     * legitimately NaN. `ctx.rotate(NaN)` poisons the transform and the hull simply
     * vanishes — no error, no warning, just a missing boat, which reads as a broken
     * app rather than as an unknown heading. The marker falls back to a circle: we
     * know where you are and not which way you point, drawn as exactly that.
     */
    ctx = new RecordingContext()
    const state = stateOf({ cog: NaN, sog: NaN, heading: null })
    render(
      <StartCanvas
        line={LINE}
        state={state}
        wind={WIND}
        numbers={numbersFor(LINE, state, WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expectNothingUndrawable(ctx, 'no heading')
    // Still drawn, and drawn as an arc rather than the pointed hull.
    expect(ctx.calls.some((c) => c.op === 'arc')).toBe(true)
    expect(ctx.calls.some((c) => c.op === 'quadraticCurveTo')).toBe(false)
  })

  it('passes nothing undrawable when there is speed but no course', () => {
    /*
     * A GPS can report a valid speed while reporting heading as null — a slow
     * drift at 0.3 kn has a magnitude but no direction. `useSensors` maps that
     * to `sog: 0.58, cog: NaN`. The COG predictor guard checked only
     * `state.sog > 0.2`, so `fromPolar(NaN, ...)` fed NaN coordinates through
     * to `ctx.lineTo` and `ctx.arc` — exactly the silent-draw-nothing defect
     * this test file exists to catch.
     */
    ctx = new RecordingContext()
    const state = stateOf({ cog: NaN, sog: 4.6, heading: null })
    render(
      <StartCanvas
        line={LINE}
        state={state}
        wind={WIND}
        numbers={numbersFor(LINE, state, WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expectNothingUndrawable(ctx, 'speed but no course')
  })

  it('still draws the pointed hull when the heading is known', () => {
    ctx = new RecordingContext()
    render(
      <StartCanvas
        line={LINE}
        state={stateOf()}
        wind={WIND}
        numbers={numbersFor(LINE, stateOf(), WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expect(ctx.calls.some((c) => c.op === 'quadraticCurveTo')).toBe(true)
  })

  it('survives a boat with no length, which would divide by zero', () => {
    ctx = new RecordingContext()
    render(
      <StartCanvas
        line={LINE}
        state={stateOf()}
        wind={WIND}
        numbers={numbersFor(LINE, stateOf(), WIND)}
        boat={{ ...BOAT, loaMetres: 0 }}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    expectNothingUndrawable(ctx, 'zero-length boat')
  })

  it('draws differently when the boat is over the line early', () => {
    // OCS is the state the screen exists to shout about, so it must change the
    // picture rather than only a number somewhere else.
    const below = stateOf()
    const over = stateOf({ position: { lat: MID.lat + 0.0006, lon: MID.lon } })

    ctx = new RecordingContext()
    const a = render(
      <StartCanvas
        line={LINE}
        state={below}
        wind={WIND}
        numbers={numbersFor(LINE, below, WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    const stylesBelow = ctx.styles.join('|')
    a.unmount()
    cleanup()

    ctx = new RecordingContext()
    render(
      <StartCanvas
        line={LINE}
        state={over}
        wind={WIND}
        numbers={numbersFor(LINE, over, WIND)}
        boat={BOAT}
        track={[]}
        secondsSinceGun={null}
      />,
    )
    const stylesOver = ctx.styles.join('|')

    expect(numbersFor(LINE, over, WIND).ocs).toBe(true)
    expect(stylesOver).not.toBe(stylesBelow)
  })
})

// ------------------------------------------------------------------ PolarPlot

describe('PolarPlot', () => {
  it('draws a polar without passing anything undrawable', () => {
    render(<PolarPlot lattice={lattice} />)
    expect(ctx.calls.length).toBeGreaterThan(10)
    expectNothingUndrawable(ctx, 'j70 lattice')
  })

  it('copes with every class in the library, at silly speed sets', () => {
    for (const id of ['optimist', 'ilca7', 'j105', 'nacra17', 'cruiser-40']) {
      for (const speeds of [[6, 10, 14, 20], [0], [0.5, 100], []]) {
        ctx = new RecordingContext()
        const view = render(
          <PolarPlot lattice={buildLattice(findPolar(id)!.polar)} speeds={speeds} />,
        )
        expectNothingUndrawable(ctx, `${id} at ${JSON.stringify(speeds)}`)
        view.unmount()
        cleanup()
      }
    }
  })

  it('draws nothing rather than throwing when its parent has no width', () => {
    /*
     * The documented crash this component already carries a guard for: R is
     * min(w/2 - 26, h - 34), so w === 0 makes every ring radius negative and
     * ctx.arc throws IndexSizeError - inside an effect, so React unmounts the tree
     * and the boundary replaces the whole Setup screen. The recorder throws on a
     * negative radius exactly as a browser does, so the guard cannot be removed
     * without this failing.
     */
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 0, configurable: true })
    ctx = new RecordingContext()
    expect(() => render(<PolarPlot lattice={lattice} />)).not.toThrow()
    expect(ctx.calls.length).toBe(0)
  })

  it('copes with a null lattice', () => {
    ctx = new RecordingContext()
    expect(() => render(<PolarPlot lattice={null} />)).not.toThrow()
  })
})

// --------------------------------------------------- CurrentChart / DepartureChart

describe('CurrentChart', () => {
  const T = Date.UTC(2026, 7, 28, 6, 0, 0)

  /** A tidal curve reversing about every six hours, as a station really does. */
  function prediction(points: number) {
    const series = []
    for (let i = 0; i < points; i++) {
      const t = T + i * 6 * 60_000
      series.push({ t, kn: 1.2 * Math.sin((i / 60) * Math.PI) })
    }
    return {
      stationId: 'CAB1401',
      floodDir: 310,
      ebbDir: 138,
      series,
      events: [
        { t: T + 30 * 60_000, type: 'slack' as const, kn: 0 },
        { t: T + 3 * 3_600_000, type: 'flood' as const, kn: 1.17 },
        { t: T + 6 * 3_600_000, type: 'slack' as const, kn: 0 },
      ],
      fetchedAt: T,
    }
  }

  it('draws a curve and passes nothing undrawable', () => {
    render(<CurrentChart prediction={prediction(480)} t={T + 2 * 3_600_000} windowHours={12} />)
    expect(ctx.calls.length).toBeGreaterThan(10)
    expectNothingUndrawable(ctx, 'twelve-hour window')
  })

  it('copes with an empty series, one point, and a marker outside the window', () => {
    /*
     * All three happen. An empty series is a station that answered with no data; a
     * single point is the first sample of a fetch in progress; a marker outside the
     * window is the timeline scrubbed beyond the prediction, which is easy to do
     * because the forecast runs 72 hours and the current prediction runs 48.
     */
    const cases: Array<[string, number, number]> = [
      ['empty series', 0, T],
      ['one point', 1, T],
      ['two points', 2, T],
      ['marker before the series', 480, T - 5 * 3_600_000],
      ['marker after the series', 480, T + 96 * 3_600_000],
    ]
    for (const [label, n, at] of cases) {
      ctx = new RecordingContext()
      const view = render(<CurrentChart prediction={prediction(n)} t={at} windowHours={12} />)
      expectNothingUndrawable(ctx, label)
      view.unmount()
      cleanup()
    }
  })

  it('copes with a zero-width window and a zero height', () => {
    for (const [w, h] of [[0, 120], [12, 0]]) {
      ctx = new RecordingContext()
      const view = render(
        <CurrentChart prediction={prediction(480)} t={T} windowHours={w} height={h} />,
      )
      expectNothingUndrawable(ctx, `window ${w} h, height ${h}`)
      view.unmount()
      cleanup()
    }
  })

  it('draws nothing rather than throwing when its parent has no width', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 0, configurable: true })
    ctx = new RecordingContext()
    expect(() => render(<CurrentChart prediction={prediction(480)} t={T} />)).not.toThrow()
    expect(ctx.calls.length).toBe(0)
  })
})

describe('DepartureChart', () => {
  const T = Date.UTC(2026, 7, 28, 6, 0, 0)

  function sweep(n: number, opts: { allFail?: boolean } = {}) {
    const options = []
    for (let i = 0; i < n; i++) {
      const departAt = T + i * 3_600_000
      const failed = opts.allFail || i === 2
      options.push({
        departAt,
        elapsedS: failed ? null : 7200 + i * 240,
        etaMs: failed ? null : departAt + (7200 + i * 240) * 1000,
        costS: failed ? null : i * 240,
        timeStepS: failed ? null : 600,
        ...(failed ? { error: 'no legal move from the frontier' } : {}),
      })
    }
    const ok = options.filter((o) => o.elapsedS != null)
    return {
      options,
      best: ok[0] ?? null,
      spreadS: ok.length > 1 ? 240 * (ok.length - 1) : null,
      stepFloorS: ok.length > 0 ? 600 : null,
      attempted: n,
      succeeded: ok.length,
      warnings: [],
    }
  }

  it('draws the sweep and passes nothing undrawable', () => {
    render(<DepartureChart sweep={sweep(13)} selected={T + 3_600_000} />)
    expect(ctx.calls.length).toBeGreaterThan(10)
    expectNothingUndrawable(ctx, 'thirteen departures')
  })

  it('copes with a sweep where nothing succeeded', () => {
    // The honest outcome of a course walled in by land, and the one where every
    // scale is degenerate: no best, no spread, no step floor.
    ctx = new RecordingContext()
    render(<DepartureChart sweep={sweep(6, { allFail: true })} />)
    expectNothingUndrawable(ctx, 'all failed')
  })

  it('copes with an empty sweep, a single departure, and a selection off the scale', () => {
    const cases: Array<[string, number, number | null]> = [
      ['no departures', 0, null],
      ['one departure', 1, T],
      ['selection before the window', 13, T - 20 * 3_600_000],
      ['selection after the window', 13, T + 200 * 3_600_000],
      ['no selection', 13, null],
    ]
    for (const [label, n, selected] of cases) {
      ctx = new RecordingContext()
      const view = render(<DepartureChart sweep={sweep(n)} selected={selected} />)
      expectNothingUndrawable(ctx, label)
      view.unmount()
      cleanup()
    }
  })

  it('draws nothing rather than throwing when its parent has no width', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 0, configurable: true })
    ctx = new RecordingContext()
    expect(() => render(<DepartureChart sweep={sweep(13)} />)).not.toThrow()
    expect(ctx.calls.length).toBe(0)
  })
})
