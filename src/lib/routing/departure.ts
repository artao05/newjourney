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
  /**
   * Isochrone time step this solve chose, seconds. Null when it failed.
   *
   * Kept per departure rather than once for the sweep because it genuinely
   * varies — see `stepFloorS`.
   */
  timeStepS: Seconds | null
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
  /**
   * The coarsest isochrone time step any successful solve used, seconds — the
   * resolution floor below which this sweep cannot honestly name a winner.
   *
   * This is not a detail. `routeIsochrone` probes the wind **at `startTime`** to
   * pick its time step (§"typicalSpeed"), so every departure in a sweep is solved
   * at a *different* discretisation — and the discretisation is correlated with
   * the very thing being measured. A departure into 4 kn gets a coarser search
   * than the same course into 14 kn, because a slower boat needs fewer, longer
   * steps to cover the leg. The sweep is therefore not quite comparing like with
   * like, and the size of that mismatch is bounded by the coarsest step used.
   *
   * Arrival is a sub-step interpolated hop, so elapsed times are not quantised to
   * the step — but the *frontier* those hops start from is only sampled every
   * step, so two departures separated by less than one step have not been
   * meaningfully distinguished. `departureAdvice` refuses to claim they have.
   *
   * Null when nothing succeeded.
   */
  stepFloorS: Seconds | null
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
      /*
       * `computeSensitivity: false` regardless of what the template asked for.
       * The sweep ranks departures by elapsed time and never looks at a
       * sensitivity field, so computing one per departure is a second full
       * backward pass and a grid allocation bought for nothing — and there are up
       * to `maxSolves` of them. A caller who wants the envelope routes the winning
       * departure once, afterwards.
       */
      result = o.route(
        { ...o.request, startTime: departAt, computeSensitivity: false },
        o.ctx,
      )
    } catch (e) {
      // The kernel contracts never to throw, but a sweep must not die on one bad
      // departure and lose the other 23 answers.
      options.push({
        departAt,
        elapsedS: null,
        etaMs: null,
        costS: null,
        timeStepS: null,
        error: e instanceof Error ? e.message : String(e),
      })
      o.onProgress?.(i + 1, departures.length)
      continue
    }
    const stepS = result.diagnostics?.timeStepS
    options.push(
      result.ok && result.elapsedS != null
        ? {
            departAt,
            elapsedS: result.elapsedS,
            etaMs: result.etaMs,
            costS: null,
            timeStepS: Number.isFinite(stepS) && stepS > 0 ? stepS : null,
          }
        : {
            departAt,
            elapsedS: null,
            etaMs: null,
            costS: null,
            timeStepS: null,
            error: result.error ?? 'no route',
          },
    )
    o.onProgress?.(i + 1, departures.length)
  }

  const ok = options.filter((d): d is DepartureOption & { elapsedS: Seconds } => d.elapsedS != null)
  if (ok.length === 0) {
    warnings.push('No departure in the window produced a route.')
    return {
      options,
      best: null,
      spreadS: null,
      stepFloorS: null,
      attempted: options.length,
      succeeded: 0,
      warnings,
    }
  }

  let best = ok[0]
  let slowest = ok[0]
  let stepFloorS: Seconds | null = null
  for (const d of ok) {
    if (d.elapsedS < best.elapsedS) best = d
    if (d.elapsedS > slowest.elapsedS) slowest = d
    if (d.timeStepS != null && (stepFloorS == null || d.timeStepS > stepFloorS)) {
      stepFloorS = d.timeStepS
    }
  }
  // Cost is relative to the winner, so the table reads as "leaving then costs you
  // 40 minutes" rather than making the reader subtract.
  for (const d of options) {
    d.costS = d.elapsedS == null ? null : d.elapsedS - best.elapsedS
  }

  // A sweep where some departures failed still returns a best and a spread, and
  // both are computed only over the ones that worked. That is the right answer to
  // a narrower question than the caller asked, so it has to say which question.
  // The usual cause is a forecast that ends inside the window, which fails the
  // later departures and leaves a confident-looking ranking of the early ones.
  if (ok.length < options.length) {
    warnings.push(
      `${options.length - ok.length} of ${options.length} departures in this window produced ` +
        `no route, so the comparison below covers only the ${ok.length} that did.`,
    )
  }

  const spreadS = ok.length >= 2 ? slowest.elapsedS - best.elapsedS : null
  // Say it here as well as in the advice: a caller reading the table directly
  // should not have to derive this from two numbers to know the ranking is noise.
  if (spreadS != null && stepFloorS != null && spreadS <= stepFloorS) {
    warnings.push(
      `The spread across this window (${Math.round(spreadS / 60)} min) is inside the ` +
        `router's own time step (${Math.round(stepFloorS / 60)} min), so these departures ` +
        `are not distinguishable at this resolution.`,
    )
  }

  return {
    options,
    best,
    spreadS,
    stepFloorS,
    attempted: options.length,
    succeeded: ok.length,
    warnings,
  }
}

/**
 * Plain-language read on whether departure timing matters here.
 *
 * Two thresholds, in this order.
 *
 * The first is the router's own resolution (`stepFloorS`). A spread inside one
 * time step is a ranking of numerical noise, and it must not be reported as a
 * preference no matter how large a fraction of the passage it is — that check has
 * to come first, because a short race is exactly where a small spread looks
 * significant *and* where the step is proportionally largest.
 *
 * The second is a fraction of the passage rather than a fixed number of minutes:
 * twenty minutes across a two-hour harbour race is the whole result, and across a
 * three-day passage it is noise.
 *
 * Returns null when there is nothing honest to say — one successful solve cannot
 * support a claim either way.
 */
export function departureAdvice(
  sweep: DepartureSweep,
): { matters: boolean; text: string } | null {
  if (!sweep.best || sweep.spreadS == null || sweep.best.elapsedS == null) return null
  const spread = sweep.spreadS
  const fraction = spread / sweep.best.elapsedS
  const mins = Math.round(spread / 60)
  /*
   * `spread` is the range across the departures that produced a route, which is
   * not the window when some of them did not. This function can only see the
   * summary, so saying "in this window" was a claim about ground it had no way to
   * know had been covered — and the usual cause of partial coverage, a forecast
   * ending mid-window, biases the survivors to one end of it.
   */
  const scope =
    sweep.succeeded < sweep.attempted
      ? `the ${sweep.succeeded} of ${sweep.attempted} departures that produced a route`
      : 'this window'
  if (sweep.stepFloorS != null && spread <= sweep.stepFloorS) {
    return {
      matters: false,
      text:
        `No usable difference: the ${mins} min between best and worst is inside the ` +
        `router's ${Math.round(sweep.stepFloorS / 60)} min time step. Leave when you like, ` +
        `or re-run at a finer resolution.`,
    }
  }
  if (fraction < 0.02) {
    return {
      matters: false,
      text: `Departure barely matters: ${mins} min between the best and worst time in ${scope}.`,
    }
  }
  if (fraction < 0.1) {
    return {
      matters: true,
      text: `Departure is worth ${mins} min across ${scope} — some gain, not decisive.`,
    }
  }
  return {
    matters: true,
    text: `Departure dominates: ${mins} min between the best and worst time in ${scope}.`,
  }
}
