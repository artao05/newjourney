/**
 * Departure-time optimisation: when to leave, and what leaving later costs.
 *
 * Tier 2 item F in docs/05-spec/improvement-plan.md, and Phase 4 of the roadmap.
 * The machinery already exists — this is a sweep over `routeIsochrone` plus the
 * arithmetic to turn a set of solves into an answer a sailor can act on.
 *
 * The question is not "what is the fastest departure". It is "how much does it
 * matter when I leave", which is the same distinction the route sensitivity band
 * makes for *where* you sail (routing-isochrone.md §8). A sweep whose spread is
 * twelve minutes across a whole morning means go when you like; one that swings
 * four hours across the same window means the tide gate is the entire race. Both
 * look identical if you only report the winner, so this reports the shape.
 *
 * Pure and synchronous by design: no worker, no fetch, no clock. It takes a
 * routing function so tests can drive it with an analytic stub, and so a caller
 * can hand it a worker-backed router without this module knowing workers exist.
 */

import type { Millis, RouteRequest, RouteResult, Seconds } from '../types'
import type { RouteContext } from './isochrone'

/** The subset of `routeIsochrone` this needs. Injected so it stays testable. */
export type RouteFn = (req: RouteRequest, ctx: RouteContext) => RouteResult

export interface DepartureOption {
  /** Departure time this solve used. */
  departAt: Millis
  /** Elapsed passage time, seconds. Null when the route failed. */
  elapsedS: Seconds | null
  /** Arrival time. Null when the route failed. */
  etaMs: Millis | null
  /**
   * Seconds slower than the best departure in the sweep. 0 for the winner.
   * Null when this departure produced no route at all.
   */
  costS: Seconds | null
  /** Why this departure produced nothing, when it produced nothing. */
  error?: string
}

export interface DepartureSweep {
  options: DepartureOption[]
  /** The fastest departure, or null when every attempt failed. */
  best: DepartureOption | null
  /**
   * Spread between the fastest and slowest *successful* departure, seconds.
   *
   * This is the number that decides whether departure timing is worth planning
   * around at all. Null when fewer than two departures succeeded, because a
   * spread needs two points and one solve tells you nothing about sensitivity.
   */
  spreadS: Seconds | null
  /** Departures attempted, and how many produced a usable route. */
  attempted: number
  succeeded: number
  warnings: string[]
}

export interface SweepOptions {
  /** Template request. Its `startTime` is ignored — the sweep supplies each one. */
  request: RouteRequest
  ctx: RouteContext
  route: RouteFn
  /** First departure to try. */
  from: Millis
  /** Last departure to try, inclusive. */
  to: Millis
  /** Gap between departures. */
  stepMs: number
  /**
   * Hard cap on solves, defaulting to 24.
   *
   * A sweep is N full route solves, and the coastal case is ~1 s each — so an
   * unbounded window at a fine step is minutes of blocked compute. When the cap
   * bites, the step is widened to cover the same window rather than truncating
   * it: a sweep that silently stopped halfway would report a "best departure"
   * that is only the best of the first half.
   */
  maxSolves?: number
  /** Cancellation hook, checked between solves. */
  shouldStop?: () => boolean
  onProgress?: (done: number, total: number) => void
}

const DEFAULT_MAX_SOLVES = 24

/**
 * Plan the departure times a sweep will actually use.
 *
 * Exported because the widening rule is worth testing on its own: it is the part
 * that decides whether the answer covers the window the user asked about.
 */
export function planDepartures(
  from: Millis,
  to: Millis,
  stepMs: number,
  maxSolves = DEFAULT_MAX_SOLVES,
): { departures: Millis[]; stepMs: number; widened: boolean } {
  const cap = Math.max(1, Math.floor(maxSolves))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return { departures: [from], stepMs, widened: false }
  }
  const span = to - from
  const requested = Math.max(1, Math.floor(stepMs))
  let step = requested
  // +1 because both ends are inclusive.
  let count = Math.floor(span / step) + 1
  let widened = false
  if (count > cap) {
    // Widen to fit, keeping both ends of the window in the sweep.
    step = Math.ceil(span / (cap - 1 || 1))
    count = Math.floor(span / step) + 1
    widened = true
  }
  const departures: Millis[] = []
  for (let i = 0; i < count; i++) departures.push(from + i * step)
  // Floating/rounding can leave the last sample just short of `to`; include the
  // endpoint so "or leave at the end of the window" is actually evaluated.
  const last = departures[departures.length - 1]
  if (last < to && departures.length < cap) departures.push(to)
  return { departures, stepMs: step, widened }
}

/**
 * Route once per candidate departure and rank the results.
 *
 * Synchronous and blocking: with the default cap this is up to 24 solves, which
 * is why a caller on the main thread should hand this to a worker rather than
 * calling it during a frame.
 */
export function sweepDepartures(o: SweepOptions): DepartureSweep {
  const warnings: string[] = []
  const { departures, stepMs, widened } = planDepartures(
    o.from,
    o.to,
    o.stepMs,
    o.maxSolves ?? DEFAULT_MAX_SOLVES,
  )
  if (widened) {
    warnings.push(
      `Departure step widened to ${Math.round(stepMs / 60000)} min to stay within ` +
        `${o.maxSolves ?? DEFAULT_MAX_SOLVES} solves; the full window is still covered.`,
    )
  }

  const options: DepartureOption[] = []
  for (let i = 0; i < departures.length; i++) {
    if (o.shouldStop?.()) {
      warnings.push(`Sweep cancelled after ${i} of ${departures.length} departures.`)
      break
    }
    const departAt = departures[i]
    let result: RouteResult
    try {
      result = o.route({ ...o.request, startTime: departAt }, o.ctx)
    } catch (e) {
      // The kernel contracts never to throw, but a sweep must not die on one bad
      // departure and lose the other 23 answers.
      options.push({
        departAt,
        elapsedS: null,
        etaMs: null,
        costS: null,
        error: e instanceof Error ? e.message : String(e),
      })
      o.onProgress?.(i + 1, departures.length)
      continue
    }
    options.push(
      result.ok && result.elapsedS != null
        ? { departAt, elapsedS: result.elapsedS, etaMs: result.etaMs, costS: null }
        : {
            departAt,
            elapsedS: null,
            etaMs: null,
            costS: null,
            error: result.error ?? 'no route',
          },
    )
    o.onProgress?.(i + 1, departures.length)
  }

  const ok = options.filter((d): d is DepartureOption & { elapsedS: Seconds } => d.elapsedS != null)
  if (ok.length === 0) {
    warnings.push('No departure in the window produced a route.')
    return { options, best: null, spreadS: null, attempted: options.length, succeeded: 0, warnings }
  }

  let best = ok[0]
  let slowest = ok[0]
  for (const d of ok) {
    if (d.elapsedS < best.elapsedS) best = d
    if (d.elapsedS > slowest.elapsedS) slowest = d
  }
  // Cost is relative to the winner, so the table reads as "leaving then costs you
  // 40 minutes" rather than making the reader subtract.
  for (const d of options) {
    d.costS = d.elapsedS == null ? null : d.elapsedS - best.elapsedS
  }

  return {
    options,
    best,
    spreadS: ok.length >= 2 ? slowest.elapsedS - best.elapsedS : null,
    attempted: options.length,
    succeeded: ok.length,
    warnings,
  }
}

/**
 * Plain-language read on whether departure timing matters here.
 *
 * The threshold is a fraction of the passage rather than a fixed number of
 * minutes: twenty minutes across a two-hour harbour race is the whole result,
 * and across a three-day passage it is noise. Returns null when there is nothing
 * honest to say — one successful solve cannot support a claim either way.
 */
export function departureAdvice(
  sweep: DepartureSweep,
): { matters: boolean; text: string } | null {
  if (!sweep.best || sweep.spreadS == null || sweep.best.elapsedS == null) return null
  const spread = sweep.spreadS
  const fraction = spread / sweep.best.elapsedS
  const mins = Math.round(spread / 60)
  if (fraction < 0.02) {
    return {
      matters: false,
      text: `Departure barely matters: ${mins} min between the best and worst time in this window.`,
    }
  }
  if (fraction < 0.1) {
    return {
      matters: true,
      text: `Departure is worth ${mins} min across this window — some gain, not decisive.`,
    }
  }
  return {
    matters: true,
    text: `Departure dominates: ${mins} min between the best and worst time in this window.`,
  }
}
