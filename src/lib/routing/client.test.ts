/**
 * The main-thread wrapper around the routing worker.
 *
 * 212 lines, zero tests, and the layer every route in the app passes through. What
 * it owns is not arithmetic but *lifecycle*: one outstanding request, supersession
 * when the user drags a waypoint, termination as the cancellation mechanism, and a
 * promise the docstring says never rejects because "the UI has exactly one path to
 * render". Every one of those is a claim about behaviour over time, which is exactly
 * the kind that rots silently.
 *
 * `Worker` does not exist in Node, so these tests install a fake one and drive
 * `onmessage` / `onerror` by hand. That is not a compromise — it is the only way to
 * test supersession and crash recovery deterministically.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutingClient, type RoutePayload } from './client'
import type { RouteRequest, RouteResult, WeatherCube } from '../types'
import type { DepartureSweep } from './departure'

// ------------------------------------------------------------------ fake worker

interface Posted {
  type: string
  id: number
  [k: string]: unknown
}

class FakeWorker {
  static instances: FakeWorker[] = []
  posted: Posted[] = []
  terminated = false
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: Posted) {
    if (this.terminated) throw new Error('postMessage to a terminated worker')
    this.posted.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  /** Deliver a response the way the real worker would. */
  reply(msg: unknown) {
    this.onmessage?.({ data: msg } as MessageEvent)
  }

  crash(message = 'boom') {
    this.onerror?.({ message } as ErrorEvent)
  }
}

const live = () => FakeWorker.instances.filter((w) => !w.terminated)
const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]

beforeEach(() => {
  FakeWorker.instances = []
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
})

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker
})

// ------------------------------------------------------------------- fixtures

const cube: WeatherCube = {
  model: 'test',
  run: 'r',
  bbox: { west: -71, south: 43, east: -70, north: 44 },
  nx: 2,
  ny: 2,
  dx: 1,
  dy: 1,
  t0: 0,
  dtMs: 3_600_000,
  nt: 1,
  params: ['u10', 'v10'],
  data: { u10: new Float32Array(4), v10: new Float32Array(4) },
}

const payload: RoutePayload = {
  cube,
  polar: { name: 'p', tws: [10], rows: [{ twa: [45, 90], bsp: [5, 6] }], reference: '10m' },
}

const req: RouteRequest = {
  start: { lat: 43.5, lon: -70.5 },
  startTime: 1000,
  marks: [{ lat: 43.7, lon: -70.2 }],
  constraints: { avoidLand: false },
  scalings: {
    polarPct: 100,
    polarPctNight: 100,
    windScalePct: 100,
    windRotateDeg: 0,
    windTimeShiftS: 0,
    currentScalePct: 100,
  },
  resolution: 'balanced',
  computeSensitivity: false,
}

const aResult = (marker: number): RouteResult => ({
  ok: true,
  legs: [],
  etaMs: marker,
  elapsedS: null,
  directTimeS: null,
  isochrones: [],
  reverseIsochrones: [],
  sensitivity: null,
  diagnostics: { nodesExplored: marker, timeStepS: 0, computeMs: 0, landAvoided: false, warnings: [] },
})

const aSweep = (marker: number): DepartureSweep => ({
  options: [],
  best: null,
  spreadS: null,
  stepFloorS: null,
  attempted: marker,
  succeeded: 0,
  warnings: [],
})

/** Has the promise settled by the next microtask? */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

// ---------------------------------------------------------------------- tests

describe('route', () => {
  it('posts one route message and resolves with the worker result', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    expect(latest().posted).toHaveLength(1)
    expect(latest().posted[0].type).toBe('route')

    latest().reply({ type: 'result', id: latest().posted[0].id, result: aResult(7) })
    await expect(p).resolves.toMatchObject({ ok: true, etaMs: 7 })
    c.dispose()
  })

  it('clones rather than transfers, so the UI keeps its cube', () => {
    // Documented deliberately: transferring detaches the typed arrays on the main
    // thread, and the wind overlay would then render an empty forecast.
    const c = new RoutingClient()
    void c.route(req, payload)
    expect(cube.data.u10.length).toBe(4)
    expect(latest().posted[0].cube).toBe(cube)
    c.dispose()
  })

  it('reports progress without resolving', async () => {
    const c = new RoutingClient()
    const seen: number[] = []
    const p = c.route(req, payload, (f) => seen.push(f))
    const id = latest().posted[0].id

    latest().reply({ type: 'progress', id, fraction: 0.25 })
    latest().reply({ type: 'progress', id, fraction: 0.5 })
    expect(seen).toEqual([0.25, 0.5])
    expect(await settled(p)).toBe(false)

    latest().reply({ type: 'result', id, result: aResult(1) })
    await p
    c.dispose()
  })

  it('ignores a response carrying the wrong id', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    const id = latest().posted[0].id

    latest().reply({ type: 'result', id: id + 99, result: aResult(999) })
    latest().reply({ type: 'progress', id: id + 99, fraction: 0.9 })
    latest().reply({ type: 'result', id, result: aResult(42) })

    await expect(p).resolves.toMatchObject({ etaMs: 42 })
    c.dispose()
  })

  it('ignores a malformed message instead of throwing', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    const id = latest().posted[0].id
    expect(() => latest().reply(undefined)).not.toThrow()
    expect(() => latest().reply({ nonsense: true })).not.toThrow()
    latest().reply({ type: 'result', id, result: aResult(3) })
    await expect(p).resolves.toMatchObject({ etaMs: 3 })
    c.dispose()
  })
})

describe('supersession', () => {
  it('a second route cancels the first in-band and starts a fresh worker', async () => {
    // What a user dragging a waypoint actually means. The first promise must settle:
    // a UI awaiting it would otherwise sit on "Routing" forever.
    const c = new RoutingClient()
    const first = c.route(req, payload)
    const firstWorker = latest()

    const second = c.route(req, payload)
    const firstResult = await first
    expect(firstResult.ok).toBe(false)
    expect(firstResult.error).toMatch(/cancelled/)
    expect(firstWorker.terminated).toBe(true)
    expect(latest()).not.toBe(firstWorker)

    latest().reply({ type: 'result', id: latest().posted[0].id, result: aResult(2) })
    await expect(second).resolves.toMatchObject({ ok: true, etaMs: 2 })
    c.dispose()
  })

  it('gives every request a distinct id, so a stale reply cannot resolve a new one', async () => {
    const c = new RoutingClient()
    const first = c.route(req, payload)
    const firstId = latest().posted[0].id
    const second = c.route(req, payload)
    const secondId = latest().posted[0].id
    expect(secondId).not.toBe(firstId)

    // The superseded id must be inert against the live request.
    latest().reply({ type: 'result', id: firstId, result: aResult(111) })
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(await settled(second)).toBe(false)

    latest().reply({ type: 'result', id: secondId, result: aResult(222) })
    await expect(second).resolves.toMatchObject({ etaMs: 222 })
    c.dispose()
  })

  it('reuses the worker for a request that follows a completed one', async () => {
    // Termination is the cancellation mechanism, but a clean finish must not pay
    // for a new worker on every route.
    const c = new RoutingClient()
    const p = c.route(req, payload)
    const w = latest()
    w.reply({ type: 'result', id: w.posted[0].id, result: aResult(1) })
    await p

    void c.route(req, payload)
    expect(latest()).toBe(w)
    expect(w.posted).toHaveLength(2)
    c.dispose()
  })
})

describe('cancel and dispose', () => {
  it('resolves the pending route in-band rather than rejecting', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    c.cancel()
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cancelled/)
    expect(r.legs).toEqual([])
  })

  it('resolves a pending sweep with its own shape', async () => {
    const c = new RoutingClient()
    const p = c.sweep(req, payload, { from: 0, to: 10, stepMs: 5 })
    c.cancel()
    const s = await p
    expect(s.best).toBeNull()
    expect(s.options).toEqual([])
    expect(s.warnings.join(' ')).toMatch(/cancelled/)
  })

  it('is safe to cancel or dispose with nothing running', () => {
    const c = new RoutingClient()
    expect(() => c.cancel()).not.toThrow()
    expect(() => c.dispose()).not.toThrow()
    expect(() => c.dispose()).not.toThrow()
  })

  it('terminates the worker so the kernel stops burning CPU', () => {
    // The inner loop has no yield point by design, so termination is the only way
    // to stop a solve nobody wants any more.
    const c = new RoutingClient()
    void c.route(req, payload)
    const w = latest()
    c.dispose()
    expect(w.terminated).toBe(true)
    expect(live()).toHaveLength(0)
  })
})

describe('sweep', () => {
  it('posts the window and resolves with the ranked set', async () => {
    const c = new RoutingClient()
    const p = c.sweep(req, payload, { from: 100, to: 900, stepMs: 200, maxSolves: 5 })
    const msg = latest().posted[0]
    expect(msg.type).toBe('sweep')
    expect(msg).toMatchObject({ from: 100, to: 900, stepMs: 200, maxSolves: 5 })

    latest().reply({ type: 'sweepResult', id: msg.id, sweep: aSweep(5) })
    await expect(p).resolves.toMatchObject({ attempted: 5 })
    c.dispose()
  })

  it('does not let a route result resolve a sweep promise', async () => {
    /*
     * The reason `Pending` is a discriminated union rather than one widened
     * `resolve`. Ids make this unreachable today; the guard exists so that adding
     * a third request kind cannot resolve a promise with a shape its caller does
     * not expect.
     */
    const c = new RoutingClient()
    const p = c.sweep(req, payload, { from: 0, to: 10, stepMs: 5 })
    const id = latest().posted[0].id

    latest().reply({ type: 'result', id, result: aResult(1) })
    expect(await settled(p)).toBe(false)

    latest().reply({ type: 'sweepResult', id, sweep: aSweep(1) })
    await p
    c.dispose()
  })
})

describe('worker crash', () => {
  it('resolves the pending request in-band with the crash reason', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    latest().crash('module failed to load')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/crashed/)
    expect(r.error).toMatch(/module failed to load/)
    c.dispose()
  })

  it('resolves a pending sweep in-band too', async () => {
    const c = new RoutingClient()
    const p = c.sweep(req, payload, { from: 0, to: 10, stepMs: 5 })
    latest().crash()
    const s = await p
    expect(s.best).toBeNull()
    expect(s.warnings.join(' ')).toMatch(/crashed/)
    c.dispose()
  })

  /*
   * The bug this file was written to find.
   *
   * `onerror` cleared `pending` but left the dead worker in place. The next
   * `route()` then saw no pending request, skipped `cancel()`, and reused the
   * crashed worker — so its message went nowhere and the promise never settled.
   * The UI sits on "Routing" with no error and no route, and the only way out is to
   * press ROUTE a second time, which cancels the hung request and rebuilds the
   * worker. A hang with no feedback is the worst of the available failure modes.
   */
  it('does not reuse a crashed worker for the next request', async () => {
    const c = new RoutingClient()
    const first = c.route(req, payload)
    const crashed = latest()
    crashed.crash()
    await first

    const second = c.route(req, payload)
    expect(latest()).not.toBe(crashed)
    expect(latest().terminated).toBe(false)

    latest().reply({ type: 'result', id: latest().posted[0].id, result: aResult(9) })
    await expect(second).resolves.toMatchObject({ ok: true, etaMs: 9 })
    c.dispose()
  })

  it('leaves no live worker behind after a crash', async () => {
    const c = new RoutingClient()
    const p = c.route(req, payload)
    latest().crash()
    await p
    expect(live()).toHaveLength(0)
    c.dispose()
  })
})
